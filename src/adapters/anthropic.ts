import type { ApprovalGate } from "../gate.js";
import type { BatchResult, ToolCall } from "../types.js";

/**
 * Anthropic Messages API adapter — gate the `tool_use` blocks in an assistant
 * message and get back `tool_result` blocks ready to send as the next user turn.
 *
 * Structurally typed against the Messages API response, so there's no dependency
 * on `@anthropic-ai/sdk`; it works with whatever version you have (or raw HTTP).
 */

/** Any content block (we only inspect `type`). */
export interface AnthropicContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A `tool_use` content block from an assistant message. */
export interface AnthropicToolUseBlock extends AnthropicContentBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input?: Record<string, unknown>;
}

/** The assistant message (or full response) whose content we scan. */
export interface AnthropicMessage {
  readonly content?: readonly AnthropicContentBlock[];
  readonly [key: string]: unknown;
}

/** A `tool_result` block to return in the next user message. */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AnthropicGuardOptions {
  /** Execute a tool by name. Return anything; it's serialized for the result. */
  readonly runTool: (
    name: string,
    input: Record<string, unknown>,
    call: ToolCall,
  ) => unknown | Promise<unknown>;
  /** Serialize a successful tool value to `tool_result` content. Default: string as-is, else JSON. */
  readonly serialize?: (value: unknown) => string;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function errorMessage(result: BatchResult<unknown>): string {
  if (result.status === "denied") return result.error.message;
  const error = (result as { error: unknown }).error;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gate every `tool_use` block in `message` and return the matching
 * `tool_result` blocks, in the same order. Approved/read tools run via
 * `runTool`; denied ones come back with `is_error: true` and the denial message.
 *
 * Return them together in **one** user message —
 * `messages.push({ role: "user", content: results })` — splitting `tool_result`
 * blocks across turns trains the model to stop making parallel calls.
 */
export async function guardAnthropicToolUses(
  message: AnthropicMessage,
  gate: ApprovalGate,
  options: AnthropicGuardOptions,
): Promise<AnthropicToolResultBlock[]> {
  const serialize = options.serialize ?? toText;

  const toolUses = (message.content ?? []).filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  );

  const results = await gate.guardAll(
    toolUses.map((tu) => {
      const call: ToolCall = { id: tu.id, name: tu.name, args: tu.input ?? {} };
      return { call, execute: () => options.runTool(tu.name, tu.input ?? {}, call) };
    }),
  );

  return results.map((result): AnthropicToolResultBlock => {
    if (result.status === "fulfilled") {
      return {
        type: "tool_result",
        tool_use_id: result.call.id,
        content: serialize(result.value),
      };
    }
    return {
      type: "tool_result",
      tool_use_id: result.call.id,
      content: errorMessage(result),
      is_error: true,
    };
  });
}
