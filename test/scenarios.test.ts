// Named after the challenge's test scenarios: bypass attempts against the approval
// mechanism, expired approvals, timeouts, malformed tool arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalDeniedError,
  createGate,
  defaultClassifier,
  defaultGate,
  staticClassifier,
} from "../src/index.js";
import { guardOpenAIToolCalls } from "../src/adapters/openai.js";
import type { ApprovalDecision, ToolCall } from "../src/index.js";

const call = (name: string, args: Record<string, unknown> = {}, id = name): ToolCall => ({
  id,
  name,
  args,
});
const gated = (name: string) => defaultGate(defaultClassifier(call(name)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const allow = async (): Promise<ApprovalDecision> => ({ approved: true });

function seeded(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

// ---------------------------------------------------------------------------
// Bypass attempts against the approval mechanism
// ---------------------------------------------------------------------------

test("bypass: two calls sharing an id are both denied without asking", async () => {
  let asked = 0;
  const ran: string[] = [];
  const gate = createGate({
    approver: async (r) => (asked++, { approved: r.call.args.name !== "prod" }),
  });
  const results = await gate.guardAll([
    { call: call("delete_service", { name: "prod" }, "dup"), execute: () => ran.push("prod") },
    { call: call("delete_service", { name: "canary" }, "dup"), execute: () => ran.push("canary") },
  ]);
  assert.deepEqual(ran, []);
  assert.equal(asked, 0);
  assert.deepEqual(results.map((r) => r.status), ["denied", "denied"]);
});

test("bypass: a batch approver cannot approve two calls with one id", async () => {
  const ran: string[] = [];
  const gate = createGate({
    approver: allow,
    batchApprover: async () => ({ dup: { approved: true } }),
  });
  await gate.guardAll([
    { call: call("delete_service", { name: "prod" }, "dup"), execute: () => ran.push("prod") },
    { call: call("delete_service", { name: "canary" }, "dup"), execute: () => ran.push("canary") },
  ]);
  assert.deepEqual(ran, []);
});

test("bypass: an approval that is not exactly `true` is a denial", async () => {
  for (const approved of ["false", "true", 1, "yes", null, undefined]) {
    let ran = false;
    const gate = createGate({ approver: async () => ({ approved }) as never });
    await assert.rejects(
      gate.guard(call("delete_db"), () => (ran = true)),
      ApprovalDeniedError,
      `approved: ${JSON.stringify(approved)}`,
    );
    assert.equal(ran, false, `approved: ${JSON.stringify(approved)}`);
  }
});

test("bypass: a batch verdict that is not exactly `true` is a denial", async () => {
  const gate = createGate({
    approver: allow,
    batchApprover: async () => ({ a: { approved: "true" } }) as never,
  });
  const [result] = await gate.guardAll([{ call: call("delete_db", {}, "a"), execute: () => 1 }]);
  assert.equal(result?.status, "denied");
});

test("bypass: tool names the heuristic does not know are gated", () => {
  for (const name of [
    "shell",
    "http_request",
    "terminate_instance",
    "destroy_cluster",
    "wire_funds",
    "refund_order",
    "truncate_table",
    "force_push",
    "shutdown_host",
    "cleanup_resources",
    "kill_process",
    "DeleteUser",
    "db.update",
    "mcp__prod__delete_service",
    "doTheThing",
    "x",
  ]) {
    assert.ok(gated(name), name);
  }
});

test("bypass: a leading read verb does not unlock a name that also writes", () => {
  for (const name of [
    "getOrCreateUser",
    "search_and_replace",
    "list_and_delete_users",
    "fetch_then_update",
    "read_write_config",
  ]) {
    assert.ok(gated(name), name);
  }
});

test("bypass: a tool named after an Object prototype key falls back, not through", () => {
  const classify = staticClassifier({ search: { sensitivity: "read" } });
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.ok(defaultGate(classify(call(name))), name);
  }
});

test("bypass: a classifier that returns junk sensitivity is gated", () => {
  assert.ok(defaultGate({ sensitivity: "READ" } as never));
  assert.ok(defaultGate({} as never));
});

test("reads in any spelling still run without a prompt", () => {
  for (const name of [
    "get_status",
    "listAlerts",
    "GetUser",
    "LIST_USERS",
    "describe-stack",
    "github.list_repos",
    "mcp__github__get_issue",
  ]) {
    assert.ok(!gated(name), name);
  }
});

test("fuzz: every spelling of a destructive call stays destructive", () => {
  const rand = seeded(42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const verbs = ["delete", "drop", "destroy", "terminate", "purge", "wipe", "truncate", "revoke", "transfer", "rm", "kill"];
  const nouns = ["user", "service", "prod_db", "bucket", "url", "account2"];
  const spellings: ((v: string, n: string) => string)[] = [
    (v, n) => `${v}_${n}`,
    (v, n) => `${v}${cap(n)}`,
    (v, n) => `${cap(v)}${cap(n)}`,
    (v, n) => `${v.toUpperCase()}_${n.toUpperCase()}`,
    (v, n) => `${v}${n.toUpperCase()}`,
    (v, n) => `${v}-${n}`,
    (v, n) => `${v}2_${n}`,
    (v, n) => `${n}_${v}`,
    (v, n) => `${n}.${v}`,
    (v, n) => `api/${v}_${n}`,
    (v, n) => `mcp__srv__${v}_${n}`,
    (v, n) => `get_${n}_and_${v}`,
  ];
  for (let i = 0; i < 2000; i++) {
    const name = pick(spellings)(pick(verbs), pick(nouns));
    assert.equal(defaultClassifier(call(name)).destructive, true, name);
  }
});

test("fuzz: names made of unknown words are always gated", () => {
  const rand = seeded(7);
  const word = () =>
    Array.from({ length: 3 + Math.floor(rand() * 8) }, () =>
      String.fromCharCode(97 + Math.floor(rand() * 26)),
    ).join("");
  for (let i = 0; i < 2000; i++) {
    const name = Array.from({ length: 1 + Math.floor(rand() * 3) }, word).join("_");
    assert.ok(gated(name), name);
  }
});

// ---------------------------------------------------------------------------
// Expired approvals and timeouts
// ---------------------------------------------------------------------------

test("timeouts: an approver that never answers is denied after approvalTimeoutMs", async () => {
  let ran = false;
  const gate = createGate({ approver: () => new Promise(() => {}), approvalTimeoutMs: 20 });
  await assert.rejects(gate.guard(call("delete_x"), () => (ran = true)), ApprovalDeniedError);
  assert.equal(ran, false);
});

test("expired approvals: a yes that arrives after approvalTimeoutMs never executes", async () => {
  let ran = false;
  const gate = createGate({
    approver: async () => (await sleep(200), { approved: true }),
    approvalTimeoutMs: 20,
  });
  await assert.rejects(gate.guard(call("scale_service"), () => (ran = true)), /20ms/);
  await sleep(250);
  assert.equal(ran, false);
});

test("timeouts: a hanging batch approver denies the batch, reads still return", async () => {
  const gate = createGate({
    approver: allow,
    batchApprover: () => new Promise(() => {}),
    approvalTimeoutMs: 20,
  });
  const results = await gate.guardAll([
    { call: call("list_incidents"), execute: () => "list" },
    { call: call("delete_service"), execute: () => "gone" },
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "denied"]);
});

// ---------------------------------------------------------------------------
// Approver and audit failures fail closed
// ---------------------------------------------------------------------------

test("approver outage: a throwing batch approver denies the batch instead of throwing", async () => {
  const gate = createGate({
    approver: allow,
    batchApprover: async () => {
      throw new Error("Slack 503");
    },
  });
  const results = await gate.guardAll([
    { call: call("list_incidents"), execute: () => "list" },
    { call: call("delete_service"), execute: () => "gone" },
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "denied"]);
  assert.match(results[1]?.status === "denied" ? results[1].error.message : "", /Slack 503/);
});

test("approver outage: a throwing single approver in guardAll denies instead of throwing", async () => {
  const gate = createGate({
    approver: async () => {
      throw new Error("pager down");
    },
  });
  const [result] = await gate.guardAll([{ call: call("delete_service"), execute: () => 1 }]);
  assert.equal(result?.status, "denied");
});

test("audit failure: a throwing onDecision blocks the call", async () => {
  let ran = 0;
  const gate = createGate({
    approver: allow,
    onDecision: () => {
      throw new Error("audit log unreachable");
    },
  });
  await assert.rejects(gate.guard(call("delete_x"), () => ran++));
  const [result] = await gate.guardAll([{ call: call("delete_x"), execute: () => ran++ }]);
  assert.equal(result?.status, "denied");
  assert.equal(ran, 0);
});

// ---------------------------------------------------------------------------
// Malformed tool arguments
// ---------------------------------------------------------------------------

test("malformed arguments: rejected before approval, never run, order kept", async () => {
  let asked = 0;
  const ran: string[] = [];
  const gate = createGate({ approver: async () => (asked++, { approved: true }) });
  const out = await guardOpenAIToolCalls(
    {
      tool_calls: [
        { id: "a", function: { name: "delete_messages", arguments: '{"channel": "#test"' } },
        { id: "b", function: { name: "list_channels", arguments: "{}" } },
        { id: "c", function: { name: "delete_messages", arguments: "[1, 2]" } },
      ],
    },
    gate,
    { runTool: (name) => (ran.push(name), "ok") },
  );
  assert.deepEqual(out.map((m) => m.tool_call_id), ["a", "b", "c"]);
  assert.deepEqual(ran, ["list_channels"]);
  assert.equal(asked, 0);
  assert.match(out[0]?.content ?? "", /arguments/);
  assert.match(out[2]?.content ?? "", /arguments/);
});

test("malformed arguments: args that cannot be copied are rejected, not run", async () => {
  let ran = false;
  const gate = createGate({ approver: allow });
  const [result] = await gate.guardAll([
    { call: call("create_x", { callback: () => 1 }), execute: () => (ran = true) },
  ]);
  assert.equal(result?.status, "rejected");
  assert.equal(ran, false);
});

// ---------------------------------------------------------------------------
// What was approved is what runs
// ---------------------------------------------------------------------------

test("args: approver and tool see the snapshot taken when the call arrived", async () => {
  const args = { name: "canary" };
  let shown = "";
  let ranWith = "";
  const gate = createGate({
    approver: async (r) => ((shown = String(r.call.args.name)), { approved: true }),
  });
  const pending = gate.guard(call("delete_service", args), (a) => (ranWith = String(a.name)));
  args.name = "prod";
  await pending;
  assert.equal(shown, "canary");
  assert.equal(ranWith, "canary");
});

test("args: the approver gets a frozen view, the tool gets its own mutable copy", async () => {
  let frozen = false;
  const gate = createGate({
    approver: async (r) => ((frozen = Object.isFrozen(r.call.args)), { approved: true }),
  });
  const out = await gate.guard(call("update_user", { tags: ["a"] }), (a) => {
    (a.tags as string[]).push("b");
    return a.tags;
  });
  assert.equal(frozen, true);
  assert.deepEqual(out, ["a", "b"]);
});
