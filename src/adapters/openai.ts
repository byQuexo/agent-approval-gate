import type { ApprovalGate } from "../gate.js";
import type { BatchResult, ToolCall } from "../types.js";

/**
 * OpenAI Chat Completions adapter — gate the `tool_calls` on an assistant
 * message and get back `role: "tool"` messages ready to append to the request.
 *
 * Structurally typed against the Chat Completions response, so there's no
 * dependency on the `openai` package; it works with whatever version you have
 * (or raw HTTP). For the Responses API, see the note in the README.
 */

export interface OpenAIFunctionCall {
  readonly name: string;
  /** JSON-encoded arguments string, per the OpenAI wire format. */
  readonly arguments: string;
}

export interface OpenAIToolCall {
  readonly id: string;
  readonly type?: "function";
  readonly function: OpenAIFunctionCall;
}

export interface OpenAIAssistantMessage {
  readonly tool_calls?: readonly OpenAIToolCall[];
  readonly [key: string]: unknown;
}

/** A `role: "tool"` message to append to `messages` after execution. */
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export interface OpenAIGuardOptions {
  readonly runTool: (
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ) => unknown | Promise<unknown>;
  /** Serialize a successful tool value to message content. Default: string as-is, else JSON. */
  readonly serialize?: (value: unknown) => string;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parse the JSON arguments string; malformed or empty input becomes `{}`. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorMessage(result: BatchResult<unknown>): string {
  if (result.status === "denied") return result.error.message;
  const error = (result as { error: unknown }).error;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gate every `tool_call` on `message` and return the matching `role: "tool"`
 * messages, in the same order. Approved/read tools run via `runTool`; denied
 * ones come back with the denial text as content so the model can react.
 *
 * OpenAI has no per-result error flag — a denied call's content is the denial
 * message; surface it to the model as an ordinary tool result.
 */
export async function guardOpenAIToolCalls(
  message: OpenAIAssistantMessage,
  gate: ApprovalGate,
  options: OpenAIGuardOptions,
): Promise<OpenAIToolMessage[]> {
  const serialize = options.serialize ?? toText;
  const toolCalls = message.tool_calls ?? [];

  const results = await gate.guardAll(
    toolCalls.map((tc) => {
      const args = parseArgs(tc.function?.arguments);
      const call: ToolCall = { id: tc.id, name: tc.function?.name ?? "unknown", args };
      return { call, execute: () => options.runTool(call.name, args, call) };
    }),
  );

  return results.map((result): OpenAIToolMessage => ({
    role: "tool",
    tool_call_id: result.call.id,
    content:
      result.status === "fulfilled" ? serialize(result.value) : errorMessage(result),
  }));
}
