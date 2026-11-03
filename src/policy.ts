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

/**
 * Verbs that mutate even after a read verb (`read_write_config`). Kept to
 * unambiguous verbs so noun-like reads (`get_order`, `get_post`) stay reads.
 */
const WRITE_VERBS = new Set([
  "create",
  "update",
  "patch",
  "insert",
  "upsert",
  "append",
  "write",
  "edit",
  "modify",
  "replace",
  "rename",
  "move",
  "save",
  "submit",
  "send",
  "publish",
  "deploy",
  "restart",
  "reboot",
  "shutdown",
  "execute",
  "exec",
  "invoke",
  "grant",
  "approve",
  "reject",
  "acknowledge",
  "ack",
  "resolve",
  "assign",
  "invite",
  "rollback",
  "restore",
  "migrate",
  "provision",
  "enable",
  "disable",
  "toggle",
  "unlock",
  "unblock",
  "reset",
  "flush",
]);

/** A read verb chained to anything else (`get_user_and_nuke`) is not a read. */
const CONNECTIVES = new Set([
  "and",
  "then",
  "or",
  "plus",
  "also",
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
 * read verb and no mutating word or connective appears anywhere in the full name. Everything
 * else, including names it has never seen, is a write and gets gated. Pin the
 * tools that matter with {@link staticClassifier} or a policy file.
 */
export const defaultClassifier: Classifier = (call: ToolCall): Classification => {
  const all = words(call.name);
  const destructive = all.some((w) => DESTRUCTIVE_VERBS.has(w));
  const mutating = destructive || all.some((w) => WRITE_VERBS.has(w) || CONNECTIVES.has(w));
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
