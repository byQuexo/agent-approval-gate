import { ApprovalDeniedError } from "./errors.js";
import { defaultClassifier, defaultGate } from "./policy.js";
import type {
  ApprovalRequest,
  Approver,
  Classifier,
  Describe,
  GateOptions,
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
  readonly #shouldGate: (c: ReturnType<Classifier>, call: ToolCall) => boolean;
  readonly #describe: Describe | undefined;
  readonly #onDecision: GateOptions["onDecision"];

  constructor(options: GateOptions) {
    this.#classify = options.classify ?? defaultClassifier;
    this.#approver = options.approver;
    this.#shouldGate = options.gate ?? ((c) => defaultGate(c));
    this.#describe = options.describe;
    this.#onDecision = options.onDecision;
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

    const reason = this.#describe
      ? await this.#describe(call, classification)
      : undefined;

    const request: ApprovalRequest = {
      call,
      classification,
      ...(reason !== undefined ? { reason } : {}),
    };

    // One approver call per gated tool call. No caching, ever.
    const decision = await this.#approver(request);
    this.#onDecision?.(request, decision);

    if (!decision.approved) {
      throw new ApprovalDeniedError(request, decision.reason);
    }

    return await execute();
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
