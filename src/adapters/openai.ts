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

/** Parse the JSON arguments string; empty means `{}`, anything not a JSON object is `undefined`. */
function parseArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    return isObject ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
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
  const parsed = (message.tool_calls ?? []).map((tc) => ({
    tc,
    name: tc.function?.name ?? "unknown",
    args: parseArgs(tc.function?.arguments),
  }));

  // Malformed arguments never reach the approver: there is no call it could approve.
  const valid = parsed.filter((p) => p.args !== undefined);
  const results = await gate.guardAll(
    valid.map(({ tc, name, args }) => {
      const call: ToolCall = { id: tc.id, name, args: args! };
      return { call, execute: (approved) => options.runTool(name, approved, call) };
    }),
  );

  let next = 0;
  return parsed.map(({ tc, name, args }): OpenAIToolMessage => {
    if (args === undefined) {
      return {
        role: "tool",
        tool_call_id: tc.id,
        content: `Tool call "${name}" was rejected: its arguments are not a JSON object.`,
      };
    }
    const result = results[next++]!;
    return {
      role: "tool",
      tool_call_id: result.call.id,
      content:
        result.status === "fulfilled" ? serialize(result.value) : errorMessage(result),
    };
  });
}
