/**
 * Core types for the approval gate.
 *
 * The gate sits between an agent's decision to call a tool and the tool
 * actually running. Reads flow through untouched; writes (and anything
 * flagged destructive) are held until an {@link Approver} says yes.
 */

/** A single tool invocation the agent wants to perform. */
export interface ToolCall {
  /** Stable id for this call (e.g. the provider's tool_call_id). */
  readonly id: string;
  /** Tool name as registered with the model. */
  readonly name: string;
  /** Arguments the model produced for the call. */
  readonly args: Readonly<Record<string, unknown>>;
}

/** How risky a tool call is. Reads are safe; writes mutate state. */
export type Sensitivity = "read" | "write";

/** The result of classifying a tool call. */
export interface Classification {
  readonly sensitivity: Sensitivity;
  /**
   * Irreversible or high-blast-radius calls (delete, scale-to-zero, payments…).
   * Destructive calls are always gated, regardless of {@link GateOptions.gate}.
   */
  readonly destructive?: boolean;
  /** Optional short label shown to the approver, e.g. "Delete deployment". */
  readonly label?: string;
}

/** Classifies a tool call into a {@link Classification}. */
export type Classifier = (call: ToolCall) => Classification;

/** What an approver is shown when a call is held. */
export interface ApprovalRequest {
  readonly call: ToolCall;
  readonly classification: Classification;
  /**
   * Human-readable reason the call is being gated. Populated by
   * {@link GateOptions.describe} when provided (e.g. an LLM one-liner).
   */
  readonly reason?: string;
}

/** An approver's verdict for a single held call. */
export type ApprovalDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason?: string };

/**
 * Decides whether a held call may run. Called **once per gated call** — the
 * gate never caches a decision, so a granted approval never carries into a
 * later call or a later turn. See {@link ApprovalGate}.
 */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Produces the human-readable reason shown to the approver. */
export type Describe = (
  call: ToolCall,
  classification: Classification,
) => string | Promise<string>;

export interface GateOptions {
  /** Classify each call. Defaults to {@link defaultClassifier}. */
  readonly classify?: Classifier;
  /** Asked to approve each gated call. Required. */
  readonly approver: Approver;
  /**
   * Predicate deciding which classified calls need approval.
   * Default: gate every `write` and everything `destructive`.
   */
  readonly gate?: (classification: Classification, call: ToolCall) => boolean;
  /** Optional reason generator surfaced to the approver. */
  readonly describe?: Describe;
  /** Called after every decision — wire this to your audit log. */
  readonly onDecision?: (
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ) => void;
}
