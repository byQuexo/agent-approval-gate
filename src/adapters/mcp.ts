import { ApprovalDeniedError } from "../errors.js";
import type { ApprovalGate } from "../gate.js";
import type { ToolCall } from "../types.js";

/**
 * MCP middleware adapter — gate tool calls at the protocol layer.
 *
 * Wrap any Model Context Protocol client so its `callTool` passes through an
 * {@link ApprovalGate} before the request ever leaves for the server. Reads run
 * untouched; writes wait for approval. Because it hooks the *transport*, every
 * tool a server exposes is covered automatically — you don't enumerate them.
 *
 * Structurally typed against the MCP SDK's `Client`, so there's no dependency on
 * `@modelcontextprotocol/sdk`; it works with whatever client you pass.
 */

/** The subset of an MCP tool-call params object we read. */
export interface McpToolCallParams {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/** Structural stand-in for an MCP `Client` (only `callTool` is required). */
export interface McpClientLike {
  callTool(params: McpToolCallParams, ...rest: any[]): Promise<any>;
}

/** Shape of an MCP `CallToolResult` we return when a call is denied. */
export interface McpCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  [key: string]: unknown;
}

export interface McpGateOptions {
  /**
   * By default a denied call resolves to an MCP error result (so the model sees
   * "denied" as the tool output and can react). Set `true` to throw
   * {@link ApprovalDeniedError} instead.
   */
  readonly rethrow?: boolean;
  /** Customize the result returned to the model on denial. */
  readonly onDenied?: (error: ApprovalDeniedError) => McpCallToolResult;
}

function defaultDenied(error: ApprovalDeniedError): McpCallToolResult {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
  };
}

/**
 * Return a copy of `client` whose `callTool` is gated. Everything else on the
 * client is delegated untouched, so the result is a drop-in replacement.
 *
 * @example
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { createGate } from "agent-approval-gate";
 * import { withApprovalGate } from "agent-approval-gate/mcp";
 *
 * const raw = new Client({ name: "host", version: "1.0.0" });
 * await raw.connect(transport);
 * const client = withApprovalGate(raw, createGate({ approver }));
 *
 * // delete_* etc. now wait for approval; reads pass straight through.
 * await client.callTool({ name: "delete_service", arguments: { name: "canary" } });
 */
export function withApprovalGate<C extends McpClientLike>(
  client: C,
  gate: ApprovalGate,
  options: McpGateOptions = {},
): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "callTool") return Reflect.get(target, prop, receiver);

      const original = (target.callTool as McpClientLike["callTool"]).bind(target);

      return (params: McpToolCallParams, ...rest: unknown[]): Promise<unknown> => {
        const name = params?.name ?? "unknown";
        const call: ToolCall = {
          id: name,
          name,
          args: params?.arguments ?? {},
        };
        const run = (args: Record<string, unknown>) =>
          original({ ...params, arguments: args }, ...rest);

        if (options.rethrow) return gate.guard(call, run);

        return gate.guard(call, run).catch((error: unknown) => {
          if (error instanceof ApprovalDeniedError) {
            return (options.onDenied ?? defaultDenied)(error);
          }
          throw error;
        });
      };
    },
  });
}
