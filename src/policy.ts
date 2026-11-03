import type { Classification, Classifier, ToolCall } from "./types.js";

/** A name whose own leading word is one of these may run without approval. */
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "find",
  "fetch",
  "describe",
  "show",
  "view",
  "lookup",
  "count",
  "inspect",
  "preview",
]);

/** Mutating words; any of them anywhere in the name overrides a read verb. */
const WRITE_VERBS = new Set([
  "create",
  "update",
  "patch",
  "put",
  "post",
  "set",
  "add",
  "insert",
  "upsert",
  "append",
  "write",
  "edit",
  "modify",
  "change",
  "replace",
  "rename",
  "move",
  "save",
  "store",
  "upload",
  "import",
  "push",
  "commit",
  "merge",
  "submit",
  "send",
  "publish",
  "notify",
  "email",
  "message",
  "reply",
  "invite",
  "assign",
  "ack",
  "acknowledge",
  "resolve",
  "close",
  "reopen",
  "approve",
  "reject",
  "enable",
  "disable",
  "toggle",
  "lock",
  "unlock",
  "block",
  "unblock",
  "deploy",
  "rollback",
  "restore",
  "migrate",
  "provision",
  "install",
  "start",
  "stop",
  "restart",
  "reboot",
  "shutdown",
  "scale",
  "reset",
  "clear",
  "flush",
  "sync",
  "schedule",
  "trigger",
  "invoke",
  "execute",
  "exec",
  "run",
  "apply",
  "grant",
  "order",
  "buy",
  "sell",
  "book",
  "sign",
]);

/** Words whose effects are hard or impossible to undo. */
const DESTRUCTIVE_VERBS = new Set([
  "delete",
  "del",
  "remove",
  "rm",
  "unlink",
  "drop",
  "destroy",
  "terminate",
  "kill",
  "purge",
  "wipe",
  "erase",
  "truncate",
  "overwrite",
  "force",
  "cleanup",
  "prune",
  "uninstall",
  "deprovision",
  "decommission",
  "revoke",
  "ban",
  "cancel",
  "pay",
  "charge",
  "transfer",
  "wire",
  "refund",
  "withdraw",
]);

/** `mcp__srv__getOrCreate-user.v2` -> `mcp srv get or create user v` */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Drop an `mcp__<server>__` prefix and any `ns.` / `ns/` / `ns:` namespace. */
function localName(name: string): string {
  return name.replace(/^mcp__.+?__/, "").split(/[.:/]/).pop() ?? name;
}

/**
 * Fail-closed heuristic: a call is a read only when its own name starts with a
 * read verb and no mutating word appears anywhere in the full name. Everything
 * else, including names it has never seen, is a write and gets gated. Pin the
 * tools that matter with {@link staticClassifier} or a policy file.
 */
export const defaultClassifier: Classifier = (call: ToolCall): Classification => {
  const all = words(call.name);
  const destructive = all.some((w) => DESTRUCTIVE_VERBS.has(w));
  const mutating = destructive || all.some((w) => WRITE_VERBS.has(w));
  const lead = words(localName(call.name))[0] ?? "";
  const read = !mutating && READ_VERBS.has(lead);
  return {
    sensitivity: read ? "read" : "write",
    ...(destructive ? { destructive: true } : {}),
  };
};

/**
 * Build a classifier from an explicit per-tool map — the recommended approach
 * for production. Unlisted tools fall back to {@link defaultClassifier}.
 *
 * @example
 * const classify = staticClassifier({
 *   search_incidents: { sensitivity: "read" },
 *   ack_incident:     { sensitivity: "write", label: "Acknowledge incident" },
 *   delete_service:   { sensitivity: "write", destructive: true },
 * });
 */
export function staticClassifier(
  map: Record<string, Classification>,
  fallback: Classifier = defaultClassifier,
): Classifier {
  return (call: ToolCall): Classification =>
    Object.hasOwn(map, call.name) ? (map[call.name] as Classification) : fallback(call);
}

/** Default gate predicate: hold everything that is not explicitly a read. */
export function defaultGate(classification: Classification): boolean {
  return classification.sensitivity !== "read" || classification.destructive === true;
}
