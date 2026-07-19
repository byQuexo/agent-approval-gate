/**
 * Runnable demo — no LLM required. Simulates an agent that wants to run three
 * tool calls: a read (allowed silently), a write (approved), and a destructive
 * delete (denied). Run with: `npm run example`.
 */
import { ApprovalDeniedError, createGate, staticClassifier } from "../src/index.js";
import type { ApprovalRequest } from "../src/index.js";

// A stand-in approver. In a CLI you'd prompt the user; in a web app you'd
// round-trip to the UI. Here we auto-approve writes but reject deletes.
async function demoApprover(req: ApprovalRequest) {
  const what = req.classification.label ?? req.call.name;
  console.log(`\n  ⏸  approval needed: ${what}`);
  console.log(`     args:   ${JSON.stringify(req.call.args)}`);
  if (req.reason) console.log(`     reason: ${req.reason}`);

  if (req.classification.destructive) {
    console.log(`     ➜ DENIED (destructive)`);
    return { approved: false as const, reason: "destructive action blocked in demo" };
  }
  console.log(`     ➜ APPROVED`);
  return { approved: true as const };
}

const gate = createGate({
  classify: staticClassifier({
    search_incidents: { sensitivity: "read" },
    ack_incident: { sensitivity: "write", label: "Acknowledge incident" },
    delete_service: { sensitivity: "write", destructive: true, label: "Delete service" },
  }),
  approver: demoApprover,
  describe: (call) => `Agent wants to run ${call.name}`,
  onDecision: (req, d) =>
    console.log(`     [audit] ${req.call.name} -> ${d.approved ? "approved" : "denied"}`),
});

// Fake tool implementations.
const tools = {
  search_incidents: async () => [{ id: "INC-42", title: "DB latency" }],
  ack_incident: async (a: { id: string }) => ({ id: a.id, status: "acknowledged" }),
  delete_service: async (a: { name: string }) => ({ deleted: a.name }),
};

// A batch reviewer for parallel tool calls: shows every pending write at once
// and decides each independently. Here: approve writes, block destructive ones.
async function demoBatchApprover(requests: readonly ApprovalRequest[]) {
  console.log(`\n  ⏸  approval needed for ${requests.length} parallel call(s):`);
  const verdict: Record<string, { approved: boolean; reason?: string }> = {};
  for (const req of requests) {
    const what = req.classification.label ?? req.call.name;
    if (req.classification.destructive) {
      console.log(`     ✘ ${what} ${JSON.stringify(req.call.args)} — DENIED (destructive)`);
      verdict[req.call.id] = { approved: false, reason: "destructive action blocked" };
    } else {
      console.log(`     ✔ ${what} ${JSON.stringify(req.call.args)} — APPROVED`);
      verdict[req.call.id] = { approved: true };
    }
  }
  return verdict;
}

async function batchDemo() {
  console.log("\n--- parallel tool calls (guardAll) ---");
  const batchGate = createGate({
    classify: staticClassifier({
      search_incidents: { sensitivity: "read" },
      ack_incident: { sensitivity: "write", label: "Acknowledge incident" },
      delete_service: { sensitivity: "write", destructive: true, label: "Delete service" },
    }),
    approver: demoApprover, // used only if no batchApprover is set
    batchApprover: demoBatchApprover,
  });

  // The shape a model emits when it fires several tool calls in one turn.
  const results = await batchGate.guardAll([
    { call: { id: "a", name: "search_incidents", args: {} }, execute: () => tools.search_incidents() },
    { call: { id: "b", name: "ack_incident", args: { id: "INC-42" } }, execute: () => tools.ack_incident({ id: "INC-42" }) },
    { call: { id: "c", name: "delete_service", args: { name: "canary" } }, execute: () => tools.delete_service({ name: "canary" }) },
  ]);

  for (const r of results) {
    if (r.status === "fulfilled") console.log(`  ✔ ${r.call.name} -> ${JSON.stringify(r.value)}`);
    else if (r.status === "denied") console.log(`  ✘ ${r.call.name} -> denied`);
    else console.log(`  ⚠ ${r.call.name} -> error: ${String(r.error)}`);
  }
}

async function main() {
  // 1. Read — flows straight through, no prompt.
  const found = await gate.guard(
    { id: "1", name: "search_incidents", args: {} },
    () => tools.search_incidents(),
  );
  console.log("✔ read result:", JSON.stringify(found));

  // 2. Write — held, approved, then runs.
  const acked = await gate.guard(
    { id: "2", name: "ack_incident", args: { id: "INC-42" } },
    () => tools.ack_incident({ id: "INC-42" }),
  );
  console.log("✔ write result:", JSON.stringify(acked));

  // 3. Destructive — held, denied, throws.
  try {
    await gate.guard(
      { id: "3", name: "delete_service", args: { name: "canary" } },
      () => tools.delete_service({ name: "canary" }),
    );
  } catch (err) {
    if (err instanceof ApprovalDeniedError) {
      console.log("✘ blocked:", err.message);
    } else {
      throw err;
    }
  }
}

void main().then(batchDemo);
