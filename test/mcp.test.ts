import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate, staticClassifier } from "../src/index.js";
import { withApprovalGate } from "../src/adapters/mcp.js";
import type { McpClientLike, McpToolCallParams } from "../src/adapters/mcp.js";

// A fake MCP client that records calls and returns a trivial result.
function fakeClient() {
  const calls: string[] = [];
  const client: McpClientLike & { calls: string[]; serverInfo: string } = {
    calls,
    serverInfo: "fake",
    async callTool(params: McpToolCallParams) {
      calls.push(params.name);
      return { content: [{ type: "text", text: `ran ${params.name}` }], isError: false };
    },
  };
  return client;
}

const classify = staticClassifier({
  search_incidents: { sensitivity: "read" },
  delete_service: { sensitivity: "write", destructive: true },
});

test("reads pass through the gate to the server", async () => {
  const raw = fakeClient();
  const client = withApprovalGate(raw, createGate({ classify, approver: async () => ({ approved: true }) }));
  const res: any = await client.callTool({ name: "search_incidents", arguments: {} });
  assert.equal(res.isError, false);
  assert.deepEqual(raw.calls, ["search_incidents"]);
});

test("approved writes reach the server", async () => {
  const raw = fakeClient();
  const client = withApprovalGate(raw, createGate({ classify, approver: async () => ({ approved: true }) }));
  await client.callTool({ name: "delete_service", arguments: { name: "canary" } });
  assert.deepEqual(raw.calls, ["delete_service"]);
});

test("denied writes never reach the server and return an MCP error result", async () => {
  const raw = fakeClient();
  const client = withApprovalGate(
    raw,
    createGate({ classify, approver: async () => ({ approved: false, reason: "no" }) }),
  );
  const res: any = await client.callTool({ name: "delete_service", arguments: { name: "canary" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /denied/i);
  assert.deepEqual(raw.calls, [], "server must not be called on denial");
});

test("rethrow option surfaces ApprovalDeniedError instead of a result", async () => {
  const raw = fakeClient();
  const client = withApprovalGate(
    raw,
    createGate({ classify, approver: async () => ({ approved: false }) }),
    { rethrow: true },
  );
  await assert.rejects(() => client.callTool({ name: "delete_service", arguments: {} }));
});

test("non-callTool members are delegated untouched", async () => {
  const raw = fakeClient();
  const client = withApprovalGate(raw, createGate({ classify, approver: async () => ({ approved: true }) }));
  assert.equal((client as any).serverInfo, "fake");
});
