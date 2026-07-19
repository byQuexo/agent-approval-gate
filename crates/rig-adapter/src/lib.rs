//! Human-in-the-loop approval gate for LLM agent tool calls — Rust core.
//!
//! Mirrors the TypeScript library's contract, including the one rule that makes
//! it safe: **an approval is scoped to a single tool call and is never cached
//! across calls or turns.**
//!
//! Status: core is usable today; the [Rig](https://github.com/0xPlaygrounds/rig)
//! `Tool` adapter lands behind the `rig` feature (see `Cargo.toml`).

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
}
