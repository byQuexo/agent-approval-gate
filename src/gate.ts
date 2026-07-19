import { ApprovalDeniedError } from "./errors.js";
import { defaultClassifier, defaultGate } from "./policy.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Approver,
  BatchApprover,
  BatchResult,
  Classification,
  Classifier,
  Describe,
  GateOptions,
  GuardedCall,
  ToolCall,
} from "./types.js";

/**
 * Wraps tool execution with a human-in-the-loop approval step.
 *
 * ## The one security rule
 *
 * The gate holds **no state between calls.** Every gated call re-invokes the
 * approver, so a "yes" is scoped to exactly one tool call and can never be
 * replayed on a later call or carried into a later turn. There is deliberately
 * no `approveAll`, no session cache, and no "remember my choice" — those are
 * the exact holes that let a compromised or drifting agent smuggle a
 * destructive call through on the back of an earlier approval.
 */
export class ApprovalGate {
  readonly #classify: Classifier;
  readonly #approver: Approver;
  readonly #batchApprover: BatchApprover | undefined;
  readonly #shouldGate: (c: ReturnType<Classifier>, call: ToolCall) => boolean;
  readonly #describe: Describe | undefined;
  readonly #onDecision: GateOptions["onDecision"];

  constructor(options: GateOptions) {
    this.#classify = options.classify ?? defaultClassifier;
    this.#approver = options.approver;
    this.#batchApprover = options.batchApprover;
    // Destructive calls are ALWAYS gated — a custom `gate` predicate can only
    // widen what's held, never let a destructive call through.
    const predicate: (c: Classification, call: ToolCall) => boolean =
      options.gate ?? ((c) => defaultGate(c));
    this.#shouldGate = (c, call) => c.destructive === true || predicate(c, call);
    this.#describe = options.describe;
    this.#onDecision = options.onDecision;
  }

  /** Build the ApprovalRequest for a gated call (runs `describe` if present). */
  async #toRequest(
    call: ToolCall,
    classification: Classification,
  ): Promise<ApprovalRequest> {
    const reason = this.#describe
      ? await this.#describe(call, classification)
      : undefined;
    return {
      call,
      classification,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /**
   * Run `execute` for `call`, first requesting approval if the call is gated.
   *
   * @throws {ApprovalDeniedError} if the approver denies the call.
   */
  async guard<T>(call: ToolCall, execute: () => Promise<T> | T): Promise<T> {
    const classification = this.#classify(call);

    if (!this.#shouldGate(classification, call)) {
      return await execute();
    }

    const request = await this.#toRequest(call, classification);

    // One approver call per gated tool call. No caching, ever.
    const decision = await this.#approver(request);
    this.#onDecision?.(request, decision);

    if (!decision.approved) {
      throw new ApprovalDeniedError(request, decision.reason);
    }

    return await execute();
  }

  /**
   * Guard a **batch** of tool calls — the shape a model produces when it emits
   * parallel tool calls in one turn.
   *
   * Reads run immediately. Every gated call in the batch is collected and shown
   * to the {@link GateOptions.batchApprover} at once (or, if none is set, sent
   * one at a time to the single approver). Approved and ungated calls then
   * execute **concurrently**; denied calls never run.
   *
   * Unlike {@link guard}, this never throws for a denial: each call gets its own
   * {@link BatchResult} (`fulfilled` | `denied` | `rejected`), returned in the
   * **same order** as the input so you can map results straight back onto the
   * model's tool calls. Approving one call in a batch says nothing about the
   * others — every gated call needs its own yes.
   *
   * Note: call ids must be unique within a batch (provider tool-call ids are).
   */
  async guardAll<T>(calls: readonly GuardedCall<T>[]): Promise<BatchResult<T>[]> {
    const entries = calls.map((c) => ({
      call: c.call,
      execute: c.execute,
      classification: this.#classify(c.call),
      gated: false,
    }));
    for (const e of entries) e.gated = this.#shouldGate(e.classification, e.call);

    // Build one ApprovalRequest per gated call.
    const requests: ApprovalRequest[] = [];
    for (const e of entries) {
      if (e.gated) requests.push(await this.#toRequest(e.call, e.classification));
    }
    const requestById = new Map(requests.map((r) => [r.call.id, r]));

    // Collect a decision for every gated call. Fail-closed on anything missing.
    const decisions = new Map<string, ApprovalDecision>();
    const batchApprover = this.#batchApprover;
    if (requests.length > 0) {
      if (batchApprover) {
        const verdicts = await batchApprover(requests);
        for (const r of requests) {
          const d: ApprovalDecision =
            verdicts[r.call.id] ??
            { approved: false, reason: "no decision returned for this call" };
          decisions.set(r.call.id, d);
          this.#onDecision?.(r, d);
        }
      } else {
        // No batch approver: fall back to the single approver, one call at a
        // time (sequential, so CLI prompts don't interleave).
        for (const r of requests) {
          const d = await this.#approver(r);
          decisions.set(r.call.id, d);
          this.#onDecision?.(r, d);
        }
      }
    }

    // Execute in original order, concurrently.
    return Promise.all(
      entries.map(async (e): Promise<BatchResult<T>> => {
        if (e.gated) {
          const d = decisions.get(e.call.id);
          if (!d || !d.approved) {
            const request = requestById.get(e.call.id) ?? {
              call: e.call,
              classification: e.classification,
            };
            const reason = d && !d.approved ? d.reason : undefined;
            return {
              call: e.call,
              status: "denied",
              error: new ApprovalDeniedError(request, reason),
            };
          }
        }
        try {
          return { call: e.call, status: "fulfilled", value: await e.execute() };
        } catch (error) {
          return { call: e.call, status: "rejected", error };
        }
      }),
    );
  }

  /**
   * Convenience wrapper that returns a guarded version of a `(args) => result`
   * tool function. Handy for adapters and manual tool loops.
   */
  protect<A extends Record<string, unknown>, R>(
    name: string,
    fn: (args: A) => Promise<R> | R,
    idFor?: (args: A) => string,
  ): (args: A) => Promise<R> {
    return (args: A) =>
      this.guard(
        { id: idFor?.(args) ?? name, name, args },
        () => fn(args),
      );
  }
}

/** Terse factory: `const gate = createGate({ approver })`. */
export function createGate(options: GateOptions): ApprovalGate {
  return new ApprovalGate(options);
}
