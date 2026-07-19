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

/// Verb-prefix heuristic mirroring the TS `defaultClassifier`.
pub fn default_classify(call: &ToolCall) -> Classification {
    const WRITE: &[&str] = &[
        "create", "update", "patch", "put", "post", "delete", "remove", "drop", "set", "add",
        "insert", "write", "send", "publish", "deploy", "restart", "scale", "execute", "run",
        "apply", "revoke", "grant", "pay", "charge", "transfer", "merge", "cancel",
    ];
    const DESTRUCTIVE: &[&str] = &[
        "delete", "remove", "drop", "revoke", "pay", "charge", "transfer", "cancel", "purge",
        "wipe",
    ];

    let verb = call
        .name
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or(&call.name)
        .to_ascii_lowercase();

    let destructive = DESTRUCTIVE.contains(&verb.as_str());
    let is_write = destructive || WRITE.contains(&verb.as_str());

    Classification {
        sensitivity: if is_write {
            Sensitivity::Write
        } else {
            Sensitivity::Read
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
