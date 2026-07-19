import type { ApprovalRequest } from "./types.js";

/**
 * Thrown when an approver denies a gated tool call.
 *
 * Catch this at the agent boundary and feed `error.message` back to the model
 * as the tool result, so the agent can react ("the user declined…") instead of
 * crashing the run.
 */
export class ApprovalDeniedError extends Error {
  readonly request: ApprovalRequest;
  readonly reason: string | undefined;

  constructor(request: ApprovalRequest, reason?: string) {
    const what = request.classification.label ?? request.call.name;
    super(
      reason
        ? `Tool call "${what}" was denied: ${reason}`
        : `Tool call "${what}" was denied by the approver.`,
    );
    this.name = "ApprovalDeniedError";
    this.request = request;
    this.reason = reason;
  }
}
