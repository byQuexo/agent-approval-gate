import type { Classification, Classifier, ToolCall } from "./types.js";

/**
 * Verb prefixes that almost always mutate state. Matched case-insensitively
 * against the leading token of a tool name (`create_alert`, `deleteUser`,
 * `db.update`, …).
 */
const WRITE_VERBS = [
  "create",
  "update",
  "patch",
  "put",
  "post",
  "delete",
  "remove",
  "drop",
  "set",
  "add",
  "insert",
  "write",
  "send",
  "publish",
  "deploy",
  "restart",
  "scale",
  "execute",
  "run",
  "apply",
  "revoke",
  "grant",
  "pay",
  "charge",
  "transfer",
  "merge",
  "cancel",
];

/** Verbs whose effects are hard or impossible to undo. */
const DESTRUCTIVE_VERBS = [
  "delete",
  "remove",
  "drop",
  "revoke",
  "pay",
  "charge",
  "transfer",
  "cancel",
  "purge",
  "wipe",
];

/** Split a tool name into its leading verb token. `create_alert` -> `create`. */
function leadingVerb(name: string): string {
  const token = name.split(/[_\-.:/\s]+/)[0] ?? name;
  // camelCase: deleteUser -> delete. No `i` flag, so it stops at the first
  // uppercase letter (with the flag it would swallow the whole word).
  const camel = token.match(/^[a-z]+/)?.[0] ?? token;
  return camel.toLowerCase();
}

/**
 * Heuristic classifier: reads unless the tool name starts with a write verb.
 * Good enough to be safe by default; override per-tool with {@link staticClassifier}
 * or your own {@link Classifier} for anything that matters.
 */
export const defaultClassifier: Classifier = (call: ToolCall): Classification => {
  const verb = leadingVerb(call.name);
  const isWrite = WRITE_VERBS.includes(verb);
  const destructive = DESTRUCTIVE_VERBS.includes(verb);
  return {
    sensitivity: isWrite || destructive ? "write" : "read",
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
  return (call: ToolCall): Classification => map[call.name] ?? fallback(call);
}

/** Default gate predicate: hold every write, and always hold destructive calls. */
export function defaultGate(classification: Classification): boolean {
  return classification.sensitivity === "write" || classification.destructive === true;
}
