# agent-approval-gate (Rust)

Human-in-the-loop approval gate for LLM agent tool calls. Classify tools
read/write, hold every write (and every destructive call) behind an approver,
and **never cache a grant across calls or turns**.

```rust
use std::sync::Arc;
use agent_approval_gate::{ApprovalGate, Approver, ApprovalRequest, Decision};

let gate = Arc::new(ApprovalGate::new(my_approver));
let result = gate
    .guard(tool_call, || async { run_tool().await })
    .await; // Err(ApprovalDenied) if the approver says no
```

- `guard` / `guard_all` — single and parallel (batch) tool calls.
- `--features rig` — wrap any [`rig`](https://github.com/0xPlaygrounds/rig)
  `Tool` with `rig::Gated<T>` (itself a `Tool`, so it drops into an agent).
- `--features yaml` — load the same YAML policy format as the TypeScript
  package (`policy::classifier_from_yaml`), including the shared `presets/`.

Part of [agent-approval-gate](https://github.com/byQuexo/agent-approval-gate),
which also ships a zero-dependency TypeScript package with OpenAI / Anthropic /
Gemini / Bedrock / MCP / Vercel AI SDK adapters. MSRV 1.85.

## License

MIT
