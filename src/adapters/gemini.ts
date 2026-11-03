import type { ApprovalGate } from "../gate.js";
import type { BatchResult, ToolCall } from "../types.js";

/**
 * Google Gemini adapter — gate the function calls in a `generateContent`
 * response and get back `functionResponse` parts ready to send as the next turn.
 *
 * Structurally typed against the Gemini response, so there's no dependency on
 * `@google/genai`; it works with whatever version you have (or raw HTTP).
 *
 * Note: Gemini function calls carry no id, so the gate's `ToolCall.id` is
 * synthesized as `name#index` (unique within the batch).
 */

export interface GeminiFunctionCall {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

export interface GeminiPart {
  readonly functionCall?: GeminiFunctionCall;
  readonly [key: string]: unknown;
}

export interface GeminiResponse {
  /** Newer SDKs expose the calls directly. */
  readonly functionCalls?: readonly GeminiFunctionCall[];
  /** Otherwise dig into candidates[0].content.parts. */
  readonly candidates?: ReadonlyArray<{
    readonly content?: { readonly parts?: readonly GeminiPart[] };
  }>;
  readonly [key: string]: unknown;
}

/** A `functionResponse` part to return in the next `user` turn. */
export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiGuardOptions {
  readonly runTool: (
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ) => unknown | Promise<unknown>;
  /**
   * Shape a successful tool value into the `functionResponse.response` object.
   * Default: objects pass through; anything else is wrapped as `{ result: value }`.
   */
  readonly serialize?: (value: unknown) => Record<string, unknown>;
}

function toObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

function errorMessage(result: BatchResult<unknown>): string {
  if (result.status === "denied") return result.error.message;
  const error = (result as { error: unknown }).error;
  return error instanceof Error ? error.message : String(error);
}

/** Pull function calls from either the flat list or the candidates tree. */
function extractCalls(response: GeminiResponse): GeminiFunctionCall[] {
  if (response.functionCalls && response.functionCalls.length > 0) {
    return [...response.functionCalls];
  }
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.functionCall)
    .filter((fc): fc is GeminiFunctionCall => fc !== undefined);
}

/**
 * Gate every function call in `response` and return the matching
 * `functionResponse` parts, in the same order. Approved/read tools run via
 * `runTool`; denied ones come back as `{ error: <message> }`.
 *
 * Wrap the parts in a user turn to continue the conversation, e.g.
 * `contents.push({ role: "user", parts: results })`.
 */
export async function guardGeminiFunctionCalls(
  response: GeminiResponse,
  gate: ApprovalGate,
  options: GeminiGuardOptions,
): Promise<GeminiFunctionResponsePart[]> {
  const serialize = options.serialize ?? toObject;
  const calls = extractCalls(response);

  const results = await gate.guardAll(
    calls.map((fc, index) => {
      const args = fc.args ?? {};
      const call: ToolCall = { id: `${fc.name}#${index}`, name: fc.name, args };
      return { call, execute: (approved) => options.runTool(fc.name, approved, call) };
    }),
  );

  return results.map((result): GeminiFunctionResponsePart => ({
    functionResponse: {
      name: result.call.name,
      response:
        result.status === "fulfilled"
          ? serialize(result.value)
          : { error: errorMessage(result) },
    },
  }));
}
