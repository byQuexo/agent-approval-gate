import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate, staticClassifier } from "../src/index.js";
import { guardAnthropicToolUses } from "../src/adapters/anthropic.js";
import { guardOpenAIToolCalls } from "../src/adapters/openai.js";
import { guardGeminiFunctionCalls } from "../src/adapters/gemini.js";
import { guardBedrockToolUses } from "../src/adapters/bedrock.js";

// Shared policy: search is a read, delete_service is a destructive write.
const classify = staticClassifier({
  search: { sensitivity: "read" },
  delete_service: { sensitivity: "write", destructive: true },
});
const denyDestructive = createGate({
  classify,
  approver: async (req) =>
    req.classification.destructive ? { approved: false, reason: "blocked" } : { approved: true },
});
const runTool = (name: string) => `ran ${name}`;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test("anthropic: gates tool_use blocks, returns tool_result blocks in order", async () => {
  const ran: string[] = [];
  const message = {
    content: [
      { type: "text", text: "let me help" },
      { type: "tool_use", id: "a", name: "search", input: {} },
      { type: "tool_use", id: "b", name: "delete_service", input: { n: 1 } },
    ],
  };
  const results = await guardAnthropicToolUses(message, denyDestructive, {
    runTool: (name) => (ran.push(name), runTool(name)),
  });

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: "tool_result", tool_use_id: "a", content: "ran search" });
  assert.equal(results[1]?.tool_use_id, "b");
  assert.equal(results[1]?.is_error, true);
  assert.match(results[1]?.content ?? "", /denied|blocked/i);
  assert.deepEqual(ran, ["search"], "denied tool must not run");
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

test("openai: gates tool_calls, returns role:tool messages in order", async () => {
  const ran: string[] = [];
  const message = {
    tool_calls: [
      { id: "a", type: "function" as const, function: { name: "search", arguments: "{}" } },
      { id: "b", type: "function" as const, function: { name: "delete_service", arguments: '{"n":1}' } },
    ],
  };
  const results = await guardOpenAIToolCalls(message, denyDestructive, {
    runTool: (name) => (ran.push(name), runTool(name)),
  });

  assert.deepEqual(results[0], { role: "tool", tool_call_id: "a", content: "ran search" });
  assert.equal(results[1]?.tool_call_id, "b");
  assert.match(results[1]?.content ?? "", /denied|blocked/i);
  assert.deepEqual(ran, ["search"]);
});

test("openai: malformed arguments are rejected and the tool never runs", async () => {
  const seen: Record<string, unknown>[] = [];
  const message = {
    tool_calls: [{ id: "a", function: { name: "search", arguments: "not json" } }],
  };
  const [out] = await guardOpenAIToolCalls(message, createGate({ classify, approver: async () => ({ approved: true }) }), {
    runTool: (_n, args) => (seen.push(args), "ok"),
  });
  assert.deepEqual(seen, []);
  assert.match(out?.content ?? "", /not a JSON object/);
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test("gemini: gates functionCalls (flat list), returns functionResponse parts", async () => {
  const response = {
    functionCalls: [
      { name: "search", args: {} },
      { name: "delete_service", args: { n: 1 } },
    ],
  };
  const results = await guardGeminiFunctionCalls(response, denyDestructive, { runTool });

  assert.deepEqual(results[0], {
    functionResponse: { name: "search", response: { result: "ran search" } },
  });
  assert.equal(results[1]?.functionResponse.name, "delete_service");
  assert.match(String(results[1]?.functionResponse.response.error), /denied|blocked/i);
});

test("gemini: also reads function calls from the candidates tree", async () => {
  const response = {
    candidates: [
      { content: { parts: [{ text: "hi" }, { functionCall: { name: "search", args: {} } }] } },
    ],
  };
  const results = await guardGeminiFunctionCalls(response, denyDestructive, { runTool });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.functionResponse.name, "search");
});

test("gemini: object tool values pass through unwrapped", async () => {
  const response = { functionCalls: [{ name: "search", args: {} }] };
  const results = await guardGeminiFunctionCalls(response, createGate({ classify, approver: async () => ({ approved: true }) }), {
    runTool: () => ({ hits: 3, top: "x" }),
  });
  assert.deepEqual(results[0]?.functionResponse.response, { hits: 3, top: "x" });
});

// ---------------------------------------------------------------------------
// AWS Bedrock (Converse API)
// ---------------------------------------------------------------------------

test("bedrock: gates toolUse blocks, returns toolResult blocks in order", async () => {
  const ran: string[] = [];
  const response = {
    output: {
      message: {
        content: [
          { text: "on it" },
          { toolUse: { toolUseId: "a", name: "search", input: {} } },
          { toolUse: { toolUseId: "b", name: "delete_service", input: { n: 1 } } },
        ],
      },
    },
  };
  const results = await guardBedrockToolUses(response, denyDestructive, {
    runTool: (name) => (ran.push(name), runTool(name)),
  });

  assert.deepEqual(results[0], {
    toolResult: { toolUseId: "a", content: [{ text: "ran search" }], status: "success" },
  });
  assert.equal(results[1]?.toolResult.toolUseId, "b");
  assert.equal(results[1]?.toolResult.status, "error");
  assert.match(String((results[1]?.toolResult.content[0] as { text: string }).text), /denied|blocked/i);
  assert.deepEqual(ran, ["search"], "denied tool must not run");
});

test("bedrock: object tool values become a json content block", async () => {
  const response = {
    output: { message: { content: [{ toolUse: { toolUseId: "a", name: "search", input: {} } }] } },
  };
  const results = await guardBedrockToolUses(
    response,
    createGate({ classify, approver: async () => ({ approved: true }) }),
    { runTool: () => ({ hits: 3 }) },
  );
  assert.deepEqual(results[0]?.toolResult.content, [{ json: { hits: 3 } }]);
});
