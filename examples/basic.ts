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

void main();
