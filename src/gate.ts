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
  Execute,
  GateOptions,
  GuardedCall,
  ToolCall,
} from "./types.js";

const TIMED_OUT = Symbol("timed out");

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Copy and freeze the call once, so classifier, approver and executor share one view. */
function snapshot(call: ToolCall): ToolCall {
  return Object.freeze({
    id: call.id,
    name: call.name,
    args: deepFreeze(structuredClone(call.args ?? {})),
  });
}

function copyArgs(call: ToolCall): Record<string, unknown> {
  return structuredClone(call.args) as Record<string, unknown>;
}

/** Only a literal `true` approves; anything else an approver returns is a denial. */
function normalize(answer: unknown, fallbackReason?: string): ApprovalDecision {
  const d = answer as { approved?: unknown; reason?: unknown } | null | undefined;
  if (d?.approved === true) return { approved: true };
  const reason = typeof d?.reason === "string" ? d.reason : fallbackReason;
  return reason === undefined ? { approved: false } : { approved: false, reason };
}

interface Entry<T> {
  readonly original: ToolCall;
  readonly call: ToolCall;
  readonly execute: Execute<T>;
  readonly classification: Classification;
  readonly gated: boolean;
  readonly invalid?: { error: unknown };
  request?: ApprovalRequest;
  decision?: ApprovalDecision;
}

/**
 * Wraps tool execution with a human-in-the-loop approval step.
 *
 * The gate holds **no state between calls.** Every gated call re-invokes the
 * approver, so a "yes" is scoped to exactly one tool call and can never be
 * replayed on a later call or carried into a later turn. Every failure path
 * (timeout, a throwing approver or audit hook, an unclear verdict, an id that
 * appears twice in a batch) ends in a denial, never in execution.
 */
export class ApprovalGate {
  readonly #classify: Classifier;
  readonly #approver: Approver;
  readonly #batchApprover: BatchApprover | undefined;
  readonly #shouldGate: (c: Classification, call: ToolCall) => boolean;
  readonly #describe: Describe | undefined;
  readonly #onDecision: GateOptions["onDecision"];
  readonly #timeoutMs: number | undefined;

  constructor(options: GateOptions) {
    this.#classify = options.classify ?? defaultClassifier;
    this.#approver = options.approver;
    this.#batchApprover = options.batchApprover;
    // A custom predicate can only widen what's held, never release a destructive call.
    const predicate: (c: Classification, call: ToolCall) => boolean =
      options.gate ?? ((c) => defaultGate(c));
    this.#shouldGate = (c, call) => c.destructive === true || predicate(c, call);
    this.#describe = options.describe;
    this.#onDecision = options.onDecision;
    this.#timeoutMs = options.approvalTimeoutMs;
  }

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

  async #withinTimeout<D>(ask: () => Promise<D>): Promise<D | typeof TIMED_OUT> {
    const pending = Promise.resolve().then(ask);
    const ms = this.#timeoutMs;
    if (ms === undefined) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(resolve, ms, TIMED_OUT);
    });
    try {
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  #timedOut(): ApprovalDecision {
    return { approved: false, reason: `no decision within ${this.#timeoutMs}ms` };
  }

  async #decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const answer = await this.#withinTimeout(() => this.#approver(request));
    const decision = answer === TIMED_OUT ? this.#timedOut() : normalize(answer);
    this.#onDecision?.(request, decision);
    return decision;
  }

  /**
   * Run `execute` for `call`, first requesting approval if the call is gated.
   * `execute` receives a copy of exactly the args the approver saw.
   *
   * @throws {ApprovalDeniedError} if the call is denied or times out.
   */
  async guard<T>(call: ToolCall, execute: Execute<T>): Promise<T> {
    const approved = snapshot(call);
    const classification = this.#classify(approved);

    if (this.#shouldGate(classification, approved)) {
      const request = await this.#toRequest(approved, classification);
      const decision = await this.#decide(request);
      if (!decision.approved) throw new ApprovalDeniedError(request, decision.reason);
    }

    return await execute(copyArgs(approved));
  }

  /**
   * Guard a **batch** of tool calls — the shape a model produces when it emits
   * parallel tool calls in one turn.
   *
   * Reads run immediately. Every gated call is shown to the
   * {@link GateOptions.batchApprover} at once (or, if none is set, sent one at a
   * time to the single approver). Approved and ungated calls then execute
   * **concurrently**; denied calls never run.
   *
   * Never throws: each call gets its own {@link BatchResult} (`fulfilled` |
   * `denied` | `rejected`) in input order. Gated calls whose id appears more
   * than once are denied without asking, since one verdict per id could not
   * tell them apart.
   */
  async guardAll<T>(calls: readonly GuardedCall<T>[]): Promise<BatchResult<T>[]> {
    const entries = calls.map((c): Entry<T> => {
      try {
        const call = snapshot(c.call);
        const classification = this.#classify(call);
        const gated = this.#shouldGate(classification, call);
        return { original: c.call, call, execute: c.execute, classification, gated };
      } catch (error) {
        const classification: Classification = { sensitivity: "write" };
        return { original: c.call, call: c.call, execute: c.execute, classification, gated: true, invalid: { error } };
      }
    });

    const gated = entries.filter((e) => e.gated && !e.invalid);
    const idCount = new Map<string, number>();
    for (const e of gated) idCount.set(e.call.id, (idCount.get(e.call.id) ?? 0) + 1);
    for (const e of gated) {
      if (idCount.get(e.call.id)! > 1) {
        e.decision = {
          approved: false,
          reason: `tool call id "${e.call.id}" appears more than once in this batch`,
        };
      }
    }

    const pending = gated.filter((e) => !e.decision);
    try {
      for (const e of pending) e.request = await this.#toRequest(e.call, e.classification);
      const requests = pending.map((e) => e.request!);
      const batchApprover = this.#batchApprover;
      if (requests.length > 0 && batchApprover) {
        const verdicts = await this.#withinTimeout(() => batchApprover(requests));
        for (const e of pending) {
          e.decision =
            verdicts === TIMED_OUT
              ? this.#timedOut()
              : normalize(
                  Object.hasOwn(verdicts, e.call.id) ? verdicts[e.call.id] : undefined,
                  "no decision returned for this call",
                );
          this.#onDecision?.(e.request!, e.decision);
        }
      } else {
        // Sequential, so CLI prompts don't interleave.
        for (const e of pending) e.decision = await this.#decide(e.request!);
      }
    } catch (error) {
      const reason = `approval failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const e of pending) e.decision = { approved: false, reason };
    }

    return Promise.all(
      entries.map(async (e): Promise<BatchResult<T>> => {
        if (e.invalid) return { call: e.original, status: "rejected", error: e.invalid.error };
        if (e.gated && !e.decision?.approved) {
          const request = e.request ?? { call: e.call, classification: e.classification };
          const reason = e.decision && !e.decision.approved ? e.decision.reason : undefined;
          return {
            call: e.original,
            status: "denied",
            error: new ApprovalDeniedError(request, reason),
          };
        }
        try {
          return { call: e.original, status: "fulfilled", value: await e.execute(copyArgs(e.call)) };
        } catch (error) {
          return { call: e.original, status: "rejected", error };
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
      this.guard({ id: idFor?.(args) ?? name, name, args }, (approved) => fn(approved as A));
  }
}

/** Terse factory: `const gate = createGate({ approver })`. */
export function createGate(options: GateOptions): ApprovalGate {
  return new ApprovalGate(options);
}
