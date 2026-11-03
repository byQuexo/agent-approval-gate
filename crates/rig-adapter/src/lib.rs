//! Human-in-the-loop approval gate for LLM agent tool calls — Rust core.
//!
//! Mirrors the TypeScript library's contract, including the one rule that makes
//! it safe: **an approval is scoped to a single tool call and is never cached
//! across calls or turns.**
//!
//! The [Rig](https://github.com/0xPlaygrounds/rig) `Tool` adapter ([`Gated`])
//! lives behind the `rig` feature (`--features rig`).

use async_trait::async_trait;

/// How risky a tool call is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "yaml", derive(serde::Deserialize))]
#[cfg_attr(feature = "yaml", serde(rename_all = "lowercase"))]
pub enum Sensitivity {
    Read,
    Write,
}

/// The result of classifying a tool call.
#[derive(Debug, Clone)]
pub struct Classification {
    pub sensitivity: Sensitivity,
    /// Irreversible / high-blast-radius calls are always gated.
    pub destructive: bool,
    pub label: Option<String>,
}

/// A single tool invocation the agent wants to perform.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments as produced by the model.
    pub args: serde_json::Value,
}

/// What the approver is shown for a held call.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub call: ToolCall,
    pub classification: Classification,
    pub reason: Option<String>,
}

/// An approver's verdict for a single held call.
#[derive(Debug, Clone)]
pub enum Decision {
    Approved,
    Denied { reason: Option<String> },
}

/// Decides whether a held call may run. Invoked **once per gated call**.
#[async_trait]
pub trait Approver: Send + Sync {
    async fn review(&self, request: &ApprovalRequest) -> Decision;

    /// Review a whole batch of gated calls at once — the shape a model produces
    /// with parallel tool calling. Returns one decision per request, in order.
    ///
    /// Default impl reviews each call individually, so existing approvers get
    /// batch support for free; override to show all pending writes together.
    async fn review_batch(&self, requests: &[ApprovalRequest]) -> Vec<Decision> {
        let mut out = Vec::with_capacity(requests.len());
        for r in requests {
            out.push(self.review(r).await);
        }
        out
    }
}

/// Per-call outcome from [`ApprovalGate::guard_all`].
#[derive(Debug)]
pub enum BatchResult<T> {
    Fulfilled { call: ToolCall, value: T },
    Denied { call: ToolCall, error: ApprovalDenied },
}

/// A boxed, heterogeneous tool executor for [`ApprovalGate::guard_all`], so a
/// batch can mix tools with different bodies.
pub type BoxExecutor<T> = Box<
    dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>> + Send,
>;

/// Wrap an async tool body into a [`BoxExecutor`].
pub fn executor<T, Fut>(f: impl FnOnce() -> Fut + Send + 'static) -> BoxExecutor<T>
where
    Fut: std::future::Future<Output = T> + Send + 'static,
{
    Box::new(move || Box::pin(f()))
}

/// Classifies a tool call. Provide your own, or use [`default_classify`].
pub trait Classifier: Send + Sync {
    fn classify(&self, call: &ToolCall) -> Classification;
}

/// Returned when a gated call is denied.
#[derive(Debug)]
pub struct ApprovalDenied {
    pub request: ApprovalRequest,
    pub reason: Option<String>,
}

impl std::fmt::Display for ApprovalDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = self
            .request
            .classification
            .label
            .as_deref()
            .unwrap_or(&self.request.call.name);
        match &self.reason {
            Some(r) => write!(f, "Tool call \"{what}\" was denied: {r}"),
            None => write!(f, "Tool call \"{what}\" was denied by the approver."),
        }
    }
}

impl std::error::Error for ApprovalDenied {}

/// A name whose own leading word is one of these may run without approval.
const READ_VERBS: &[&str] = &[
    "get", "list", "search", "read", "find", "fetch", "describe", "show", "view", "lookup",
    "count", "inspect", "preview",
];

/// Mutating words; any of them anywhere in the name overrides a read verb.
const WRITE_VERBS: &[&str] = &[
    "create", "update", "patch", "put", "post", "set", "add", "insert", "upsert", "append",
    "write", "edit", "modify", "change", "replace", "rename", "move", "save", "store", "upload",
    "import", "push", "commit", "merge", "submit", "send", "publish", "notify", "email",
    "message", "reply", "invite", "assign", "ack", "acknowledge", "resolve", "close", "reopen",
    "approve", "reject", "enable", "disable", "toggle", "lock", "unlock", "block", "unblock",
    "deploy", "rollback", "restore", "migrate", "provision", "install", "start", "stop",
    "restart", "reboot", "shutdown", "scale", "reset", "clear", "flush", "sync", "schedule",
    "trigger", "invoke", "execute", "exec", "run", "apply", "grant", "order", "buy", "sell",
    "book", "sign",
];

/// Words whose effects are hard or impossible to undo.
const DESTRUCTIVE_VERBS: &[&str] = &[
    "delete", "del", "remove", "rm", "unlink", "drop", "destroy", "terminate", "kill", "purge",
    "wipe", "erase", "truncate", "overwrite", "force", "cleanup", "prune", "uninstall",
    "deprovision", "decommission", "revoke", "ban", "cancel", "pay", "charge", "transfer",
    "wire", "refund", "withdraw",
];

/// `mcp__srv__getOrCreate-user.v2` -> `mcp srv get or create user v`
fn words(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_ascii_alphabetic() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if c.is_ascii_uppercase() && !cur.is_empty() {
            let prev = chars[i - 1];
            let next_is_lower = chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            if prev.is_ascii_lowercase() || (prev.is_ascii_uppercase() && next_is_lower) {
                out.push(std::mem::take(&mut cur));
            }
        }
        cur.push(c.to_ascii_lowercase());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Drop an `mcp__<server>__` prefix and any `ns.` / `ns/` / `ns:` namespace.
fn local_name(name: &str) -> &str {
    let rest = name
        .strip_prefix("mcp__")
        .and_then(|r| r.get(1..)?.find("__").map(|i| &r[i + 3..]))
        .unwrap_or(name);
    rest.rsplit(['.', ':', '/']).next().unwrap_or(rest)
}

/// Fail-closed heuristic mirroring the TS `defaultClassifier`: a call is a read
/// only when its own name starts with a read verb and no mutating word appears
/// anywhere in the full name. Everything else, unknown names included, is a write.
pub fn default_classify(call: &ToolCall) -> Classification {
    let all = words(&call.name);
    let has = |list: &[&str]| all.iter().any(|w| list.contains(&w.as_str()));
    let destructive = has(DESTRUCTIVE_VERBS);
    let mutating = destructive || has(WRITE_VERBS);
    let lead = words(local_name(&call.name)).into_iter().next().unwrap_or_default();
    let read = !mutating && READ_VERBS.contains(&lead.as_str());

    Classification {
        sensitivity: if read {
            Sensitivity::Read
        } else {
            Sensitivity::Write
        },
        destructive,
        label: None,
    }
}

/// Wraps tool execution with a human-in-the-loop approval step.
pub struct ApprovalGate<A: Approver> {
    approver: A,
    classify: Box<dyn Fn(&ToolCall) -> Classification + Send + Sync>,
}

impl<A: Approver> ApprovalGate<A> {
    /// Build a gate using the built-in [`default_classify`] heuristic.
    pub fn new(approver: A) -> Self {
        Self {
            approver,
            classify: Box::new(default_classify),
        }
    }

    /// Provide a custom classifier.
    pub fn with_classifier(
        approver: A,
        classify: impl Fn(&ToolCall) -> Classification + Send + Sync + 'static,
    ) -> Self {
        Self {
            approver,
            classify: Box::new(classify),
        }
    }

    fn should_gate(c: &Classification) -> bool {
        c.sensitivity == Sensitivity::Write || c.destructive
    }

    /// Request approval (if gated) and run `execute`. The approver is called
    /// afresh every time — no decision is ever cached.
    pub async fn guard<T, F, Fut>(
        &self,
        call: ToolCall,
        execute: F,
    ) -> Result<T, ApprovalDenied>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let classification = (self.classify)(&call);

        if !Self::should_gate(&classification) {
            return Ok(execute().await);
        }

        let request = ApprovalRequest {
            call,
            classification,
            reason: None,
        };

        match self.approver.review(&request).await {
            Decision::Approved => Ok(execute().await),
            Decision::Denied { reason } => Err(ApprovalDenied {
                request,
                reason,
            }),
        }
    }

    /// Guard a batch of tool calls (parallel tool calling). Reads pass through;
    /// gated calls are reviewed together via [`Approver::review_batch`]. Returns
    /// one [`BatchResult`] per input call, in the same order — approved and
    /// ungated calls run, denied ones don't. Approving one call in a batch says
    /// nothing about the others.
    pub async fn guard_all<T>(
        &self,
        calls: Vec<(ToolCall, BoxExecutor<T>)>,
    ) -> Vec<BatchResult<T>> {
        let classified: Vec<(ToolCall, BoxExecutor<T>, Classification, bool)> = calls
            .into_iter()
            .map(|(call, exec)| {
                let c = (self.classify)(&call);
                let gated = Self::should_gate(&c);
                (call, exec, c, gated)
            })
            .collect();

        // Build requests for gated calls and remember their positions.
        let mut requests = Vec::new();
        let mut gated_positions = Vec::new();
        for (i, (call, _, c, gated)) in classified.iter().enumerate() {
            if *gated {
                gated_positions.push(i);
                requests.push(ApprovalRequest {
                    call: call.clone(),
                    classification: c.clone(),
                    reason: None,
                });
            }
        }

        // One batch review for the whole turn. Fail-closed if the approver
        // returns the wrong number of verdicts.
        let verdicts = if requests.is_empty() {
            Vec::new()
        } else {
            let v = self.approver.review_batch(&requests).await;
            if v.len() == requests.len() {
                v
            } else {
                (0..requests.len())
                    .map(|_| Decision::Denied {
                        reason: Some("approver returned a mismatched verdict count".into()),
                    })
                    .collect()
            }
        };

        let mut decision_by_pos = std::collections::HashMap::new();
        for (slot, pos) in gated_positions.iter().enumerate() {
            decision_by_pos.insert(*pos, verdicts[slot].clone());
        }

        // Execute in order. (Kept sequential here for a dependency-light core;
        // callers that want concurrency can spawn the approved executors.)
        let mut results = Vec::with_capacity(classified.len());
        for (i, (call, exec, _c, gated)) in classified.into_iter().enumerate() {
            if gated {
                match decision_by_pos.get(&i) {
                    Some(Decision::Approved) => {}
                    other => {
                        let reason = match other {
                            Some(Decision::Denied { reason }) => reason.clone(),
                            _ => None,
                        };
                        results.push(BatchResult::Denied {
                            call: call.clone(),
                            error: ApprovalDenied {
                                request: ApprovalRequest {
                                    call,
                                    classification: _c,
                                    reason: None,
                                },
                                reason,
                            },
                        });
                        continue;
                    }
                }
            }
            let value = exec().await;
            results.push(BatchResult::Fulfilled { call, value });
        }
        results
    }
}

// ---------------------------------------------------------------------------
// Rig adapter (feature = "rig")
// ---------------------------------------------------------------------------

/// Wrap any [`rig_core::tool::Tool`] so its `call` passes through an
/// [`ApprovalGate`]. `Gated<T, A>` is itself a `Tool` (and therefore a
/// `ToolDyn`, via Rig's blanket impl), so it drops straight into an agent
/// builder or `ToolSet` — reads run untouched, writes wait for approval.
///
/// ```ignore
/// use std::sync::Arc;
/// use agent_approval_gate::{ApprovalGate, rig::Gated};
///
/// let gate = Arc::new(ApprovalGate::new(my_approver));
/// let agent = client
///     .agent("gpt-4o")
///     .tool(Gated::new(SearchIncidents, gate.clone())) // read — never prompts
///     .tool(Gated::new(DeleteService, gate.clone()))   // write — gated
///     .build();
/// ```
///
/// Requires `T::Args: serde::Serialize` so the arguments can be shown to the
/// approver (they are already `Deserialize` for Rig).
#[cfg(feature = "rig")]
pub mod rig {
    use super::{ApprovalDenied, ApprovalGate, Approver, ToolCall};
    use rig_core::tool::{Tool, ToolCallExtensions};
    use serde::Serialize;
    use std::sync::Arc;

    /// Error returned by a [`Gated`] tool: either the human denied the call, or
    /// the wrapped tool itself failed.
    #[derive(Debug)]
    pub enum GatedError<E> {
        /// The approver denied the call — surface this to the model as the tool
        /// result so the agent can react instead of crashing. Boxed to keep the
        /// error type (and thus every tool `Result`) small.
        Denied(Box<ApprovalDenied>),
        /// The wrapped tool returned its own error.
        Inner(E),
    }

    impl<E: std::fmt::Display> std::fmt::Display for GatedError<E> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                GatedError::Denied(d) => write!(f, "{d}"),
                GatedError::Inner(e) => write!(f, "{e}"),
            }
        }
    }

    impl<E: std::error::Error + 'static> std::error::Error for GatedError<E> {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            match self {
                GatedError::Denied(d) => Some(d.as_ref()),
                GatedError::Inner(e) => Some(e),
            }
        }
    }

    /// A Rig tool wrapped with an approval gate. Build with [`Gated::new`].
    pub struct Gated<T, A: Approver> {
        inner: T,
        gate: Arc<ApprovalGate<A>>,
    }

    impl<T, A: Approver> Gated<T, A> {
        pub fn new(inner: T, gate: Arc<ApprovalGate<A>>) -> Self {
            Self { inner, gate }
        }
    }

    impl<T, A> Tool for Gated<T, A>
    where
        T: Tool,
        T::Args: Serialize,
        A: Approver + 'static,
    {
        const NAME: &'static str = T::NAME;
        type Error = GatedError<T::Error>;
        type Args = T::Args;
        type Output = T::Output;

        fn name(&self) -> String {
            self.inner.name()
        }
        fn description(&self) -> String {
            self.inner.description()
        }
        fn parameters(&self) -> serde_json::Value {
            self.inner.parameters()
        }

        async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
            let name = self.inner.name();
            let tc = ToolCall {
                id: name.clone(),
                name,
                args: serde_json::to_value(&args).unwrap_or(serde_json::Value::Null),
            };
            flatten(self.gate.guard(tc, || async move { self.inner.call(args).await }).await)
        }

        async fn call_with_extensions(
            &self,
            args: Self::Args,
            extensions: &ToolCallExtensions,
        ) -> Result<Self::Output, Self::Error> {
            // Gate on the dynamic/agent path too, forwarding extensions so the
            // wrapped tool still sees any injected auth/session values.
            let name = self.inner.name();
            let tc = ToolCall {
                id: name.clone(),
                name,
                args: serde_json::to_value(&args).unwrap_or(serde_json::Value::Null),
            };
            flatten(
                self.gate
                    .guard(tc, || async move {
                        self.inner.call_with_extensions(args, extensions).await
                    })
                    .await,
            )
        }
    }

    /// Collapse the gate's `Result<Result<O, E>, ApprovalDenied>` into the
    /// tool's `Result<O, GatedError<E>>`.
    fn flatten<O, E>(
        r: Result<Result<O, E>, ApprovalDenied>,
    ) -> Result<O, GatedError<E>> {
        match r {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(GatedError::Inner(e)),
            Err(d) => Err(GatedError::Denied(Box::new(d))),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{Gated, GatedError};
        use crate::{ApprovalGate, ApprovalRequest, Approver, Decision};
        use rig_core::tool::Tool;
        use std::sync::Arc;

        #[derive(serde::Deserialize, serde::Serialize)]
        struct Args {
            name: String,
        }

        struct DeleteService;
        impl Tool for DeleteService {
            const NAME: &'static str = "delete_service";
            type Error = std::convert::Infallible;
            type Args = Args;
            type Output = String;
            fn description(&self) -> String {
                "deletes a service".into()
            }
            fn parameters(&self) -> serde_json::Value {
                serde_json::json!({ "type": "object" })
            }
            async fn call(&self, args: Args) -> Result<String, Self::Error> {
                Ok(format!("deleted {}", args.name))
            }
        }

        struct DenyAll;
        #[async_trait::async_trait]
        impl Approver for DenyAll {
            async fn review(&self, _r: &ApprovalRequest) -> Decision {
                Decision::Denied { reason: Some("policy".into()) }
            }
        }

        struct AllowAll;
        #[async_trait::async_trait]
        impl Approver for AllowAll {
            async fn review(&self, _r: &ApprovalRequest) -> Decision {
                Decision::Approved
            }
        }

        #[tokio::test]
        async fn wrapped_write_tool_is_denied() {
            let gate = Arc::new(ApprovalGate::new(DenyAll));
            let tool = Gated::new(DeleteService, gate);
            let res = tool.call(Args { name: "prod-api".into() }).await;
            assert!(matches!(res, Err(GatedError::Denied(_))));
        }

        #[tokio::test]
        async fn wrapped_write_tool_runs_when_approved() {
            let gate = Arc::new(ApprovalGate::new(AllowAll));
            let tool = Gated::new(DeleteService, gate);
            let out = tool.call(Args { name: "canary".into() }).await.unwrap();
            assert_eq!(out, "deleted canary");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct CountingApprover(Arc<AtomicUsize>, bool);

    #[async_trait]
    impl Approver for CountingApprover {
        async fn review(&self, _r: &ApprovalRequest) -> Decision {
            self.0.fetch_add(1, Ordering::SeqCst);
            if self.1 {
                Decision::Approved
            } else {
                Decision::Denied { reason: None }
            }
        }
    }

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: name.into(),
            name: name.into(),
            args: serde_json::Value::Null,
        }
    }

    #[tokio::test]
    async fn reads_are_not_gated() {
        let n = Arc::new(AtomicUsize::new(0));
        let gate = ApprovalGate::new(CountingApprover(n.clone(), true));
        let r = gate.guard(call("get_status"), || async { 1 }).await.unwrap();
        assert_eq!(r, 1);
        assert_eq!(n.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn approval_is_never_cached() {
        let n = Arc::new(AtomicUsize::new(0));
        let gate = ApprovalGate::new(CountingApprover(n.clone(), true));
        for _ in 0..3 {
            gate.guard(call("send_email"), || async { 1 }).await.unwrap();
        }
        assert_eq!(n.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn denied_calls_do_not_execute() {
        let n = Arc::new(AtomicUsize::new(0));
        let gate = ApprovalGate::new(CountingApprover(n, false));
        let mut ran = false;
        let res = gate
            .guard(call("delete_user"), || async {
                ran = true;
                1
            })
            .await;
        assert!(res.is_err());
        assert!(!ran);
    }

    #[test]
    fn default_classify_handles_snake_and_camel_case() {
        assert_eq!(default_classify(&call("get_status")).sensitivity, Sensitivity::Read);
        assert_eq!(default_classify(&call("create_alert")).sensitivity, Sensitivity::Write);
        // camelCase: leading verb must resolve to `delete`, not `deleteuser`.
        assert!(default_classify(&call("deleteUser")).destructive);
        assert_eq!(default_classify(&call("listAlerts")).sensitivity, Sensitivity::Read);
    }

    #[test]
    fn default_classify_fails_closed_like_the_ts_heuristic() {
        let gated = |n: &str| default_classify(&call(n)).sensitivity == Sensitivity::Write;
        for n in [
            "shell",
            "terminate_instance",
            "wire_funds",
            "DeleteUser",
            "db.update",
            "mcp__prod__delete_service",
            "getOrCreateUser",
            "search_and_replace",
            "x",
        ] {
            assert!(gated(n), "{n}");
        }
        for n in ["GetUser", "LIST_USERS", "describe-stack", "github.list_repos", "mcp__github__get_issue"] {
            assert!(!gated(n), "{n}");
        }
        for n in ["deleteURL", "DELETE_USER", "delete2_user", "user.drop", "api/rm_file", "HTTPDelete"] {
            assert!(default_classify(&call(n)).destructive, "{n}");
        }
    }

    /// Approves everything except destructive calls — a realistic batch policy.
    struct PolicyApprover;

    #[async_trait]
    impl Approver for PolicyApprover {
        async fn review(&self, r: &ApprovalRequest) -> Decision {
            if r.classification.destructive {
                Decision::Denied {
                    reason: Some("destructive".into()),
                }
            } else {
                Decision::Approved
            }
        }
    }

    #[tokio::test]
    async fn guard_all_runs_approved_and_reads_but_not_denied() {
        let gate = ApprovalGate::new(PolicyApprover);
        let results = gate
            .guard_all(vec![
                (call("search_incidents"), executor(|| async { "list" })),
                (call("ack_incident"), executor(|| async { "acked" })),
                (call("delete_service"), executor(|| async { "gone" })),
            ])
            .await;

        assert_eq!(results.len(), 3);
        assert!(matches!(results[0], BatchResult::Fulfilled { .. }));
        assert!(matches!(results[1], BatchResult::Fulfilled { .. }));
        assert!(matches!(results[2], BatchResult::Denied { .. }));
        // Order is preserved so results map back onto the model's tool calls.
        assert_eq!(results[2].call_name(), "delete_service");
    }

    impl<T> BatchResult<T> {
        fn call_name(&self) -> &str {
            match self {
                BatchResult::Fulfilled { call, .. } => &call.name,
                BatchResult::Denied { call, .. } => &call.name,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// YAML policy loader (feature = "yaml")
// ---------------------------------------------------------------------------

/// Load a declarative classification policy from YAML — the same format as the
/// TypeScript package and the shipped `presets/*.yml` files.
///
/// ```ignore
/// use std::sync::Arc;
/// use agent_approval_gate::{ApprovalGate, policy::classifier_from_yaml};
///
/// let classify = classifier_from_yaml(&std::fs::read_to_string("policy.yml")?)?;
/// let gate = Arc::new(ApprovalGate::with_classifier(my_approver, classify));
/// ```
#[cfg(feature = "yaml")]
pub mod policy {
    use super::{default_classify, Classification, Sensitivity, ToolCall};
    use serde::Deserialize;
    use std::collections::HashMap;

    /// How to classify a tool matching neither `tools` nor `patterns`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum Unlisted {
        /// Fall back to the built-in verb heuristic ([`default_classify`]).
        #[default]
        Heuristic,
        /// Treat as a read (never gated).
        Read,
        /// Treat as a write (gated).
        Write,
    }

    #[derive(Debug, Clone, Default, Deserialize)]
    pub struct Defaults {
        #[serde(default)]
        pub unlisted: Unlisted,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct PolicyRule {
        #[serde(default)]
        pub sensitivity: Option<Sensitivity>,
        #[serde(default)]
        pub destructive: bool,
        #[serde(default)]
        pub label: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct PolicyPattern {
        #[serde(rename = "match")]
        pub pattern: String,
        #[serde(default)]
        pub sensitivity: Option<Sensitivity>,
        #[serde(default)]
        pub destructive: bool,
        #[serde(default)]
        pub label: Option<String>,
    }

    /// A parsed policy document.
    #[derive(Debug, Clone, Default, Deserialize)]
    pub struct PolicyConfig {
        #[serde(default)]
        pub version: Option<u32>,
        #[serde(default)]
        pub defaults: Defaults,
        #[serde(default)]
        pub tools: HashMap<String, PolicyRule>,
        #[serde(default)]
        pub patterns: Vec<PolicyPattern>,
    }

    fn to_classification(
        sensitivity: Option<Sensitivity>,
        destructive: bool,
        label: Option<String>,
    ) -> Classification {
        Classification {
            // Omitted sensitivity is fail-safe: treat as a gated write.
            sensitivity: sensitivity.unwrap_or(Sensitivity::Write),
            destructive,
            label,
        }
    }

    /// Match a glob (`*` = any run, `?` = one char) against a tool name.
    fn glob_match(pattern: &str, text: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let t: Vec<char> = text.chars().collect();
        let (mut pi, mut ti) = (0usize, 0usize);
        let (mut star, mut mark) = (None, 0usize);
        while ti < t.len() {
            if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
                pi += 1;
                ti += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star = Some(pi);
                mark = ti;
                pi += 1;
            } else if let Some(s) = star {
                pi = s + 1;
                mark += 1;
                ti = mark;
            } else {
                return false;
            }
        }
        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }

    /// Build a classifier from a parsed [`PolicyConfig`]. Resolution order per
    /// call: exact tool match → first matching pattern → the `unlisted` default.
    pub fn classifier_from_config(
        config: PolicyConfig,
    ) -> impl Fn(&ToolCall) -> Classification + Send + Sync + 'static {
        let PolicyConfig {
            tools,
            patterns,
            defaults,
            ..
        } = config;
        let unlisted = defaults.unlisted;

        move |call: &ToolCall| {
            if let Some(rule) = tools.get(&call.name) {
                return to_classification(rule.sensitivity, rule.destructive, rule.label.clone());
            }
            for p in &patterns {
                if glob_match(&p.pattern, &call.name) {
                    return to_classification(p.sensitivity, p.destructive, p.label.clone());
                }
            }
            match unlisted {
                Unlisted::Read => Classification {
                    sensitivity: Sensitivity::Read,
                    destructive: false,
                    label: None,
                },
                Unlisted::Write => Classification {
                    sensitivity: Sensitivity::Write,
                    destructive: false,
                    label: None,
                },
                Unlisted::Heuristic => default_classify(call),
            }
        }
    }

    /// Parse a YAML policy string and build a classifier in one step.
    pub fn classifier_from_yaml(
        yaml: &str,
    ) -> Result<impl Fn(&ToolCall) -> Classification + Send + Sync + 'static, serde_yaml::Error>
    {
        let config: PolicyConfig = serde_yaml::from_str(yaml)?;
        Ok(classifier_from_config(config))
    }

    #[cfg(test)]
    mod tests {
        use super::classifier_from_yaml;
        use crate::{Sensitivity, ToolCall};

        fn call(name: &str) -> ToolCall {
            ToolCall {
                id: name.into(),
                name: name.into(),
                args: serde_json::Value::Null,
            }
        }

        #[test]
        fn loads_and_classifies() {
            let yaml = r#"
version: 1
defaults:
  unlisted: write
tools:
  search_incidents: { sensitivity: read }
  delete_service: { sensitivity: write, destructive: true }
patterns:
  - { match: "*_incident", sensitivity: write }
"#;
            let classify = classifier_from_yaml(yaml).unwrap();
            assert_eq!(classify(&call("search_incidents")).sensitivity, Sensitivity::Read);
            assert!(classify(&call("delete_service")).destructive);
            assert_eq!(classify(&call("ack_incident")).sensitivity, Sensitivity::Write);
            assert_eq!(classify(&call("unknown_tool")).sensitivity, Sensitivity::Write);
        }

        #[test]
        fn loads_the_shipped_infra_preset() {
            let yaml = include_str!("../../../presets/infra.yml");
            let classify = classifier_from_yaml(yaml).unwrap();
            assert!(classify(&call("delete_cluster")).destructive);
            assert_eq!(classify(&call("deploy_service")).sensitivity, Sensitivity::Write);
            assert!(!classify(&call("deploy_service")).destructive);
        }
    }
}
