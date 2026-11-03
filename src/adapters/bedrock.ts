import type { ApprovalGate } from "../gate.js";
import type { BatchResult, ToolCall } from "../types.js";

/**
 * AWS Bedrock **Converse API** adapter — gate the `toolUse` blocks in a
 * Converse response and get back `toolResult` blocks ready to send as the next
 * user turn. Works for any Bedrock model that supports tool use (Claude, Nova,
 * Llama, …), since Converse is Bedrock's unified format.
 *
 * Structurally typed against the Converse response, so there's no dependency on
 * `@aws-sdk/client-bedrock-runtime`; it works with whatever version you have.
 *
 * Driving Claude on Bedrock through the Messages-API Mantle client instead?
 * Use `agent-approval-gate/anthropic` — that's the native `tool_use` shape.
 */

/** Any Converse content block (we only inspect `toolUse`). */
export interface BedrockContentBlock {
  readonly [key: string]: unknown;
}

/** A `toolUse` content block from a Converse assistant message. */
export interface BedrockToolUseBlock extends BedrockContentBlock {
  readonly toolUse: {
    readonly toolUseId: string;
    readonly name: string;
    readonly input?: Record<string, unknown>;
  };
}

/** A Converse response (or just its `output`) whose content we scan. */
export interface BedrockConverseResponse {
  readonly output?: {
    readonly message?: { readonly content?: readonly BedrockContentBlock[] };
  };
  readonly [key: string]: unknown;
}

/** Converse result content: a text block or a JSON block. */
export type BedrockResultContent =
  | { readonly text: string }
  | { readonly json: Record<string, unknown> };

/** A `toolResult` block to return in the next user message. */
export interface BedrockToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: BedrockResultContent[];
    status: "success" | "error";
  };
}

export interface BedrockGuardOptions {
  readonly runTool: (
    name: string,
    input: Record<string, unknown>,
    call: ToolCall,
  ) => unknown | Promise<unknown>;
  /**
   * Shape a successful tool value into Converse result content. Default: a
   * string becomes `[{ text }]`, anything else `[{ json }]` (objects) or
   * `[{ text }]` (primitives serialized).
   */
  readonly serialize?: (value: unknown) => BedrockResultContent[];
}

function toContent(value: unknown): BedrockResultContent[] {
  if (typeof value === "string") return [{ text: value }];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return [{ json: value as Record<string, unknown> }];
  }
  return [{ text: JSON.stringify(value) }];
}

function errorMessage(result: BatchResult<unknown>): string {
  if (result.status === "denied") return result.error.message;
  const error = (result as { error: unknown }).error;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gate every `toolUse` block in a Converse response and return the matching
 * `toolResult` blocks, in the same order. Approved/read tools run via `runTool`
 * (`status: "success"`); denied ones come back with `status: "error"` and the
 * denial message so the model can react.
 *
 * Return them together in one user message:
 * `messages.push({ role: "user", content: results })`.
 */
export async function guardBedrockToolUses(
  response: BedrockConverseResponse,
  gate: ApprovalGate,
  options: BedrockGuardOptions,
): Promise<BedrockToolResultBlock[]> {
  const serialize = options.serialize ?? toContent;

  const content = response.output?.message?.content ?? [];
  const toolUses = content.filter(
    (block): block is BedrockToolUseBlock =>
      !!(block as { toolUse?: unknown }).toolUse,
  );

  const results = await gate.guardAll(
    toolUses.map((block) => {
      const { toolUseId, name, input } = block.toolUse;
      const call: ToolCall = { id: toolUseId, name, args: input ?? {} };
      return { call, execute: (args) => options.runTool(name, args, call) };
    }),
  );

  return results.map((result): BedrockToolResultBlock => {
    if (result.status === "fulfilled") {
      return {
        toolResult: {
          toolUseId: result.call.id,
          content: serialize(result.value),
          status: "success",
        },
      };
    }
    return {
      toolResult: {
        toolUseId: result.call.id,
        content: [{ text: errorMessage(result) }],
        status: "error",
      },
    };
  });
}
