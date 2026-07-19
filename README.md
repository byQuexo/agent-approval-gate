# agent-approval-gate

**Human-in-the-loop approval for LLM agent tool calls.** Let your agent read
freely, but hold every *write* — and every *destructive* action — until a human
says yes. Zero runtime dependencies.

```
   agent wants:  delete_service({ name: "prod-api" })
        │
        ▼
   ┌─────────────────────────────────────────────┐
   │  ⏸  Approval needed — Delete service          │
   │     args: { "name": "prod-api" }              │
   │     reason: agent is cleaning up canaries     │
   │        [ Approve ]   [ Deny ]                 │
   └─────────────────────────────────────────────┘
        │ deny
        ▼
   ApprovalDeniedError → fed back to the model as the tool result
```

> **Why this exists.** Handing an autonomous agent a `delete`, `deploy`, or
> `transfer_funds` tool is the scary part of shipping agents. Approval prompts
> are easy to bolt on badly — and the classic mistake is *caching* a "yes."
> This library makes the safe thing the default and the unsafe thing impossible.

---

## The one rule that makes it safe

**A granted approval is scoped to exactly one tool call. It is never cached, never
replayed, and never carried into the next turn.** There is deliberately no
`approveAll`, no session grant, no "remember my choice." Those are exactly the
holes that let a drifting or prompt-injected agent smuggle a destructive call
through on the back of an approval you gave earlier for something else.

```ts
// same tool, same args, three times → the approver is asked three times.
await gate.guard(call("send_email", { to: "a@b.c" }), send);
await gate.guard(call("send_email", { to: "a@b.c" }), send);
await gate.guard(call("send_email", { to: "a@b.c" }), send);
```

This property is enforced by a test, not just a promise. See
[`test/gate.test.ts`](test/gate.test.ts) → *"SECURITY: approval is never cached across calls."*

---

## Install

```bash
npm install agent-approval-gate
```

## 60-second example

```ts
import { createGate, staticClassifier, ApprovalDeniedError } from "agent-approval-gate";

const gate = createGate({
  // Say which tools mutate state. Unlisted tools fall back to a verb heuristic.
  classify: staticClassifier({
    search_incidents: { sensitivity: "read" },
    ack_incident:     { sensitivity: "write", label: "Acknowledge incident" },
    delete_service:   { sensitivity: "write", destructive: true, label: "Delete service" },
  }),

  // Called once per gated call. Prompt a human however you like.
  approver: async ({ call, classification, reason }) => {
    const ok = await askHuman(`Run ${classification.label ?? call.name}?`, call.args, reason);
    return ok ? { approved: true } : { approved: false, reason: "user declined" };
  },
});

// Wrap any tool execution. Reads run straight through; writes are held.
const result = await gate.guard(
  { id: "call_1", name: "delete_service", args: { name: "canary" } },
  () => deleteService({ name: "canary" }),
);
```

Deny a call and `guard()` throws `ApprovalDeniedError`. Catch it at the agent
boundary and return `err.message` to the model as the tool result — the agent
then reasons about the refusal instead of crashing.

## Drop-in for the Vercel AI SDK

Wrap your whole tool set once; nothing else in your agent loop changes:

```ts
import { generateText } from "ai";
import { createGate } from "agent-approval-gate";
import { withApprovalGate } from "agent-approval-gate/ai-sdk";

const gate = createGate({ approver: cliApprover });

await generateText({
  model,
  tools: withApprovalGate({ searchIncidents, ackIncident, deleteService }, gate),
  prompt: "Ack the DB incident, then delete the stale canary service.",
});
// searchIncidents runs silently · ackIncident & deleteService each wait for approval
```

## Parallel tool calls (batching)

Modern models emit **several tool calls in one turn**. Gating each one with a
separate prompt is wrong twice over: the human gets interleaved pop-ups, and —
worse — a single "yes" can feel like it covered the whole batch. `guardAll`
shows every pending write together and takes **one decision per call**, then
runs the approved (and read-only) calls concurrently:

```ts
const gate = createGate({
  batchApprover: async (requests) => {
    // `requests` holds only the *gated* calls. Show them together, decide each.
    const verdicts = await ui.reviewBatch(requests); // your UI / CLI
    return Object.fromEntries(
      requests.map((r) => [r.call.id, verdicts[r.call.id] ?? { approved: false }]),
    );
  },
});

const results = await gate.guardAll([
  { call: { id: "a", name: "search_incidents", args: {} },              execute: () => search() },
  { call: { id: "b", name: "ack_incident",     args: { id: "INC-1" } }, execute: () => ack("INC-1") },
  { call: { id: "c", name: "delete_service",   args: { name: "old" } }, execute: () => del("old") },
]);

// results keep input order, so they map 1:1 back onto the model's tool calls:
for (const r of results) {
  if (r.status === "fulfilled") sendToolResult(r.call.id, r.value);
  else if (r.status === "denied") sendToolResult(r.call.id, r.error.message); // agent reacts
  else sendToolResult(r.call.id, `error: ${r.error}`);
}
```

- **Never throws.** Each call reports `fulfilled` | `denied` | `rejected`, so one
  denied call can't sink the rest of the batch — exactly what you need when every
  tool call must return a result to the model.
- **Fail-closed.** A call the approver omits from its verdict map is treated as
  denied.
- **Per-call consent.** Approving one call in a batch grants nothing to the
  others, and (as always) nothing carries into the next turn.
- **No batch approver?** `guardAll` falls back to your single `approver`, one
  gated call at a time — so it works either way.

> **AI SDK note:** the SDK invokes each tool's `execute` separately, so
> `withApprovalGate` gates parallel calls independently (fine for auto-approve
> or web UIs). For a single *batched* approval prompt, drive tools through
> `guardAll` in your own loop or an MCP middleware.

## How classification works

- **`staticClassifier(map)`** — the production path. Declare each tool's
  sensitivity explicitly; unknown tools fall back to the heuristic.
- **`defaultClassifier`** — a heuristic: a tool is a *write* if its name starts
  with a mutating verb (`create`, `update`, `delete`, `deploy`, `send`, …) and
  *destructive* for irreversible ones (`delete`, `drop`, `revoke`, `charge`, …).
  Safe-by-default, but pin the tools that matter with `staticClassifier`.

By default the gate holds every `write` and every `destructive` call. Override
with `gate: (classification, call) => boolean` — but destructive calls are
**always** gated regardless, so a permissive predicate can't open that door.

## API

| Export | What it does |
| --- | --- |
| `createGate(options)` / `new ApprovalGate(options)` | Build a gate. |
| `gate.guard(call, execute)` | Run `execute`, requesting approval first if gated. Throws `ApprovalDeniedError` on denial. |
| `gate.guardAll(calls)` | Guard a **batch** of parallel calls; returns one `BatchResult` per call, in order. Never throws. |
| `gate.protect(name, fn, idFor?)` | Turn a plain `(args) => result` tool into a guarded one. |
| `staticClassifier(map, fallback?)` | Per-tool classification map. |
| `defaultClassifier` / `defaultGate` | The built-in heuristics. |
| `ApprovalDeniedError` | Thrown when an approver denies a call. |

`options`: `{ approver, batchApprover?, classify?, gate?, describe?, onDecision? }`.
`describe` generates the human-readable reason shown to the approver (wire it to
an LLM one-liner if you like). `onDecision` fires after every verdict — point it
at your audit log.

## Run it locally

```bash
npm install
npm run example   # narrated demo, no API key needed
npm test          # includes the no-caching security test
```

## Roadmap

- [ ] MCP middleware adapter (gate tool calls at the protocol layer)
- [ ] LangChain / LangGraph adapter
- [ ] `crates/rig-adapter` — Rust adapter for the [Rig](https://github.com/0xPlaygrounds/rig) LLM framework (stub in tree)
- [ ] Policy presets (finance, infra, comms)

## License

MIT © [byQuexo](https://github.com/byQuexo)
