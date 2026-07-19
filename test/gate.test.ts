import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalDeniedError,
  createGate,
  defaultClassifier,
  staticClassifier,
} from "../src/index.js";
import type { ApprovalRequest } from "../src/index.js";

const allow = async () => ({ approved: true as const });
const deny = async () => ({ approved: false as const, reason: "nope" });
const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: name,
  name,
  args,
});

test("reads are not gated (approver never called)", async () => {
  let asked = 0;
  const gate = createGate({
    approver: async () => {
      asked++;
      return { approved: true };
    },
  });
  const r = await gate.guard(call("search_users"), () => "ok");
  assert.equal(r, "ok");
  assert.equal(asked, 0);
});

test("writes are gated and run after approval", async () => {
  let asked = 0;
  const gate = createGate({
    approver: async () => {
      asked++;
      return { approved: true };
    },
  });
  const r = await gate.guard(call("create_user"), () => "created");
  assert.equal(r, "created");
  assert.equal(asked, 1);
});

test("denied calls throw ApprovalDeniedError and never execute", async () => {
  let ran = false;
  const gate = createGate({ approver: deny });
  await assert.rejects(
    () => gate.guard(call("delete_user"), () => ((ran = true), "x")),
    (err: unknown) => {
      assert.ok(err instanceof ApprovalDeniedError);
      assert.match(err.message, /denied/i);
      return true;
    },
  );
  assert.equal(ran, false);
});

test("SECURITY: approval is never cached across calls", async () => {
  const seen: string[] = [];
  const approver = async (req: ApprovalRequest) => {
    seen.push(req.call.id);
    return { approved: true as const };
  };
  const gate = createGate({ approver });

  // Same tool, same args, three times. Each must re-ask.
  await gate.guard(call("send_email", { to: "a@b.c" }), () => 1);
  await gate.guard(call("send_email", { to: "a@b.c" }), () => 1);
  await gate.guard(call("send_email", { to: "a@b.c" }), () => 1);

  assert.equal(seen.length, 3, "approver must be invoked once per gated call");
});

test("destructive calls are gated even if gate predicate says otherwise", async () => {
  let asked = 0;
  const gate = createGate({
    classify: staticClassifier({
      wipe_db: { sensitivity: "read", destructive: true },
    }),
    // A permissive predicate that would let reads through...
    gate: (c) => c.sensitivity === "write",
    approver: async () => {
      asked++;
      return { approved: true };
    },
  });
  // ...but destructive still forces a prompt.
  await gate.guard(call("wipe_db"), () => "wiped");
  assert.equal(asked, 1);
});

test("defaultClassifier flags common verbs", () => {
  assert.equal(defaultClassifier(call("get_status")).sensitivity, "read");
  assert.equal(defaultClassifier(call("listAlerts")).sensitivity, "read");
  assert.equal(defaultClassifier(call("create_alert")).sensitivity, "write");
  assert.equal(defaultClassifier(call("deleteUser")).destructive, true);
});

test("onDecision fires for every gated decision", async () => {
  const log: string[] = [];
  const gate = createGate({
    approver: allow,
    onDecision: (req, d) => log.push(`${req.call.name}:${d.approved}`),
  });
  await gate.guard(call("update_config"), () => 1);
  await gate.guard(call("read_config"), () => 1); // not gated -> no decision
  assert.deepEqual(log, ["update_config:true"]);
});

test("protect() wraps a plain tool function", async () => {
  const gate = createGate({ approver: allow });
  const send = gate.protect("send_sms", async (a: { to: string }) => `sent:${a.to}`);
  assert.equal(await send({ to: "123" }), "sent:123");
});

// ---------------------------------------------------------------------------
// Parallel / batch tool calls
// ---------------------------------------------------------------------------

test("guardAll: reads run, writes gated per-call, results keep input order", async () => {
  const gate = createGate({
    batchApprover: async (reqs) => {
      // Approve the ack, deny the delete. Each judged on its own.
      const out: Record<string, { approved: boolean; reason?: string }> = {};
      for (const r of reqs) {
        out[r.call.id] = r.classification.destructive
          ? { approved: false, reason: "blocked" }
          : { approved: true };
      }
      return out as any;
    },
  });

  const ran: string[] = [];
  const results = await gate.guardAll([
    { call: call("search_incidents", {}), execute: () => (ran.push("read"), "list") },
    { call: call("ack_incident", { id: "1" }), execute: () => (ran.push("ack"), "acked") },
    { call: call("delete_service", { n: "x" }), execute: () => (ran.push("del"), "gone") },
  ]);

  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "fulfilled");
  assert.equal(results[2]?.status, "denied");
  assert.deepEqual(results.map((r) => r.call.name), [
    "search_incidents",
    "ack_incident",
    "delete_service",
  ]);
  assert.ok(!ran.includes("del"), "denied call must not execute");
  assert.ok(ran.includes("read") && ran.includes("ack"));
});

test("guardAll: batchApprover is invoked exactly once with all gated calls", async () => {
  let batches = 0;
  let sawGated = 0;
  const gate = createGate({
    approver: allow,
    batchApprover: async (reqs) => {
      batches++;
      sawGated = reqs.length;
      return Object.fromEntries(reqs.map((r) => [r.call.id, { approved: true }])) as any;
    },
  });
  await gate.guardAll([
    { call: call("read_a"), execute: () => 1 },
    { call: call("create_b"), execute: () => 2 },
    { call: call("update_c"), execute: () => 3 },
  ]);
  assert.equal(batches, 1, "one batch review for the whole turn");
  assert.equal(sawGated, 2, "only the two writes are shown to the approver");
});

test("guardAll: fail-closed when the batch approver omits a call", async () => {
  const gate = createGate({
    approver: allow,
    batchApprover: async () => ({}) as any, // returns no verdicts
  });
  const [res] = await gate.guardAll([
    { call: call("delete_everything"), execute: () => "boom" },
  ]);
  assert.equal(res?.status, "denied");
});

test("guardAll: captures a thrown tool error as 'rejected', not a crash", async () => {
  const gate = createGate({ approver: allow });
  const results = await gate.guardAll([
    { call: call("create_x"), execute: () => { throw new Error("kaboom"); } },
    { call: call("create_y"), execute: () => "ok" },
  ]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "fulfilled");
});

test("guardAll: falls back to the single approver when no batchApprover is set", async () => {
  let asked = 0;
  const gate = createGate({
    approver: async () => (asked++, { approved: true }),
  });
  await gate.guardAll([
    { call: call("read_a"), execute: () => 1 },
    { call: call("create_b"), execute: () => 2 },
    { call: call("delete_c"), execute: () => 3 },
  ]);
  assert.equal(asked, 2, "one approval per gated call, reads skipped");
});
