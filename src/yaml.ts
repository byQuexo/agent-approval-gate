/**
 * YAML policy loader — an **optional** entry point (`agent-approval-gate/yaml`).
 *
 * This is the only part of the package with a runtime dependency: the `yaml`
 * package (declared as an optional peer dependency). The core (`.`) stays
 * dependency-free. Install `yaml` yourself if you use this module:
 *
 * ```bash
 * npm install yaml
 * ```
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { classifierFromConfig, validatePolicy } from "./policy-config.js";
import type { PolicyConfig } from "./policy-config.js";
import type { Classifier } from "./types.js";

/** Parse + validate a YAML policy string into a {@link PolicyConfig}. */
export function parsePolicy(yamlText: string): PolicyConfig {
  const data: unknown = parse(yamlText);
  validatePolicy(data);
  return data;
}

/** Build a {@link Classifier} straight from a YAML policy string. */
export function classifierFromYaml(yamlText: string): Classifier {
  return classifierFromConfig(parsePolicy(yamlText));
}

/**
 * Read a `.yml`/`.yaml` policy file from disk and build a {@link Classifier}.
 * Node only. Throws on read error, invalid YAML, or a malformed policy.
 */
export function loadPolicyFile(path: string): Classifier {
  return classifierFromYaml(readFileSync(path, "utf8"));
}
