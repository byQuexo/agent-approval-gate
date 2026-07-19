import { defaultClassifier } from "./policy.js";
import type { Classification, Classifier, Sensitivity, ToolCall } from "./types.js";

/**
 * Declarative policy — the data behind {@link classifierFromConfig}. Load it
 * from anywhere (a YAML file via `agent-approval-gate/yaml`, JSON, a DB row);
 * this module only cares about the shape, not the source.
 */
export interface PolicyConfig {
  /** Schema version, for forward compatibility. Currently `1`. */
  readonly version?: number;
  readonly defaults?: {
    /**
     * How to classify a tool that matches neither `tools` nor `patterns`:
     * - `heuristic` (default) — fall back to the built-in verb heuristic
     * - `read` — treat as read (never gated)
     * - `write` — treat as write (gated)
     */
    readonly unlisted?: "heuristic" | "read" | "write";
  };
  /** Exact tool-name → rule. Checked first. */
  readonly tools?: Readonly<Record<string, PolicyRule>>;
  /** Glob rules (`*`, `?`), checked in order after exact matches. */
  readonly patterns?: readonly PolicyPattern[];
}

export interface PolicyRule {
  /** `read` or `write`. Omitted → `write` (fail-safe: unknown intent is gated). */
  readonly sensitivity?: Sensitivity;
  /** Mark irreversible calls; always gated regardless of the gate predicate. */
  readonly destructive?: boolean;
  /** Human-friendly label shown to the approver. */
  readonly label?: string;
}

export interface PolicyPattern extends PolicyRule {
  /** Glob matched against the tool name, e.g. `delete_*`, `*_incident`. */
  readonly match: string;
}

/** Thrown by {@link validatePolicy} when a config is malformed. */
export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConfigError";
  }
}

const SENSITIVITIES: readonly string[] = ["read", "write"];
const UNLISTED: readonly string[] = ["heuristic", "read", "write"];

/**
 * Validate a parsed config, throwing {@link PolicyConfigError} with a precise
 * path on the first problem. Call this after parsing untrusted YAML/JSON so a
 * typo fails loudly at load time instead of silently mis-gating a tool.
 */
export function validatePolicy(config: unknown): asserts config is PolicyConfig {
  if (config === null || typeof config !== "object") {
    throw new PolicyConfigError("policy must be an object");
  }
  const c = config as Record<string, unknown>;

  if (c.version !== undefined && typeof c.version !== "number") {
    throw new PolicyConfigError("`version` must be a number");
  }
  if (c.defaults !== undefined) {
    const d = c.defaults as Record<string, unknown>;
    if (d.unlisted !== undefined && !UNLISTED.includes(d.unlisted as string)) {
      throw new PolicyConfigError(
        `\`defaults.unlisted\` must be one of ${UNLISTED.join(" | ")}`,
      );
    }
  }
  if (c.tools !== undefined) {
    if (typeof c.tools !== "object" || c.tools === null) {
      throw new PolicyConfigError("`tools` must be a map of name -> rule");
    }
    for (const [name, rule] of Object.entries(c.tools)) {
      validateRule(rule, `tools.${name}`);
    }
  }
  if (c.patterns !== undefined) {
    if (!Array.isArray(c.patterns)) {
      throw new PolicyConfigError("`patterns` must be a list");
    }
    c.patterns.forEach((p, i) => {
      const path = `patterns[${i}]`;
      if (p === null || typeof p !== "object") {
        throw new PolicyConfigError(`${path} must be an object`);
      }
      if (typeof (p as Record<string, unknown>).match !== "string") {
        throw new PolicyConfigError(`${path}.match is required and must be a string`);
      }
      validateRule(p, path);
    });
  }
}

function validateRule(rule: unknown, path: string): void {
  if (rule === null || typeof rule !== "object") {
    throw new PolicyConfigError(`${path} must be an object`);
  }
  const r = rule as Record<string, unknown>;
  if (r.sensitivity !== undefined && !SENSITIVITIES.includes(r.sensitivity as string)) {
    throw new PolicyConfigError(`${path}.sensitivity must be "read" or "write"`);
  }
  if (r.destructive !== undefined && typeof r.destructive !== "boolean") {
    throw new PolicyConfigError(`${path}.destructive must be a boolean`);
  }
  if (r.label !== undefined && typeof r.label !== "string") {
    throw new PolicyConfigError(`${path}.label must be a string`);
  }
}

function ruleToClassification(rule: PolicyRule): Classification {
  const destructive = rule.destructive === true;
  return {
    sensitivity: rule.sensitivity ?? "write",
    ...(destructive ? { destructive: true } : {}),
    ...(rule.label !== undefined ? { label: rule.label } : {}),
  };
}

/** Compile a glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${pattern}$`);
}

/**
 * Build a {@link Classifier} from a {@link PolicyConfig}. Resolution order per
 * call: exact tool match → first matching pattern → the `unlisted` default.
 *
 * Validates the config first, so a bad policy throws {@link PolicyConfigError}
 * here rather than mis-classifying at runtime.
 */
export function classifierFromConfig(config: PolicyConfig): Classifier {
  validatePolicy(config);

  const tools = config.tools ?? {};
  const patterns = (config.patterns ?? []).map((p) => ({
    re: globToRegExp(p.match),
    rule: p,
  }));
  const unlisted = config.defaults?.unlisted ?? "heuristic";

  return (call: ToolCall): Classification => {
    const exact = tools[call.name];
    if (exact) return ruleToClassification(exact);

    for (const p of patterns) {
      if (p.re.test(call.name)) return ruleToClassification(p.rule);
    }

    if (unlisted === "read") return { sensitivity: "read" };
    if (unlisted === "write") return { sensitivity: "write" };
    return defaultClassifier(call);
  };
}
