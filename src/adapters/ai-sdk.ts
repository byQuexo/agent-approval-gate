import type { ApprovalGate } from "../gate.js";

/**
 * Minimal structural type matching a Vercel AI SDK tool. We only touch
 * `execute`, so we avoid a hard dependency on the `ai` package — this adapter
 * works against whatever version you have installed.
 */
interface SdkTool {
  execute?: (args: any, options: any) => Promise<any> | any;
  [key: string]: unknown;
}

type ToolSet = Record<string, SdkTool>;

/**
 * Wrap an AI SDK `tools` object so every tool's `execute` passes through an
 * {@link ApprovalGate}. Tools without an `execute` (client-side / provider
 * tools) are returned untouched.
 *
 * @example
 * import { generateText } from "ai";
 * import { createGate } from "agent-approval-gate";
 * import { withApprovalGate } from "agent-approval-gate/ai-sdk";
 *
 * const gate = createGate({ approver: cliApprover });
 *
 * await generateText({
 *   model,
 *   tools: withApprovalGate({ searchIncidents, ackIncident, deleteService }, gate),
 *   prompt: "Ack the DB incident and delete the stale canary service.",
 * });
 */
export function withApprovalGate<T extends ToolSet>(tools: T, gate: ApprovalGate): T {
  const out = {} as ToolSet;

  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (typeof execute !== "function") {
      out[name] = tool;
      continue;
    }

    out[name] = {
      ...tool,
      execute: (args: any, options: any) => {
        const id =
          (options && typeof options.toolCallId === "string"
            ? options.toolCallId
            : undefined) ?? name;
        return gate.guard(
          { id, name, args: (args ?? {}) as Record<string, unknown> },
          (approved) => execute(approved, options),
        );
      },
    };
  }

  return out as T;
}
