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
