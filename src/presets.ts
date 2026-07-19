import type { PolicyConfig, PolicyPattern, PolicyRule } from "./policy-config.js";

/**
 * Ready-made {@link PolicyConfig} presets for common domains. Compose them with
 * your own tool map via {@link mergePolicies}, then feed to
 * `classifierFromConfig`. They only add glob patterns — they don't set an
 * `unlisted` default — so they layer cleanly on top of your policy.
 *
 * These are sensible starting points, not a security guarantee: review and
 * tighten them for your actual tool names before relying on them.
 */

/** Finance: money movement and trading are write, irreversible ones destructive. */
export const financePolicy: PolicyConfig = {
  version: 1,
  patterns: [
    { match: "transfer*", sensitivity: "write", destructive: true },
    { match: "*payment*", sensitivity: "write", destructive: true },
    { match: "pay_*", sensitivity: "write", destructive: true },
    { match: "charge_*", sensitivity: "write", destructive: true },
    { match: "refund_*", sensitivity: "write", destructive: true },
    { match: "withdraw*", sensitivity: "write", destructive: true },
    { match: "deposit*", sensitivity: "write" },
    { match: "*_order", sensitivity: "write", destructive: true },
    { match: "execute_trade", sensitivity: "write", destructive: true },
    { match: "buy_*", sensitivity: "write", destructive: true },
    { match: "sell_*", sensitivity: "write", destructive: true },
  ],
};

/** Infra: provisioning is write; teardown and arbitrary exec are destructive. */
export const infraPolicy: PolicyConfig = {
  version: 1,
  patterns: [
    { match: "delete_*", sensitivity: "write", destructive: true },
    { match: "destroy_*", sensitivity: "write", destructive: true },
    { match: "terminate_*", sensitivity: "write", destructive: true },
    { match: "drop_*", sensitivity: "write", destructive: true },
    { match: "purge_*", sensitivity: "write", destructive: true },
    { match: "run_command", sensitivity: "write", destructive: true },
    { match: "exec_*", sensitivity: "write", destructive: true },
    { match: "deploy_*", sensitivity: "write" },
    { match: "rollback_*", sensitivity: "write" },
    { match: "restart_*", sensitivity: "write" },
    { match: "reboot_*", sensitivity: "write" },
    { match: "stop_*", sensitivity: "write" },
    { match: "scale_*", sensitivity: "write" },
    { match: "apply_*", sensitivity: "write" },
  ],
};

/** Comms: sending is write; anything broadcast/published is destructive (wide reach). */
export const commsPolicy: PolicyConfig = {
  version: 1,
  patterns: [
    { match: "publish_*", sensitivity: "write", destructive: true },
    { match: "broadcast_*", sensitivity: "write", destructive: true },
    { match: "tweet*", sensitivity: "write", destructive: true },
    { match: "send_*", sensitivity: "write" },
    { match: "reply_*", sensitivity: "write" },
    { match: "post_*", sensitivity: "write" },
    { match: "email_*", sensitivity: "write" },
    { match: "dm_*", sensitivity: "write" },
    { match: "message_*", sensitivity: "write" },
    { match: "notify_*", sensitivity: "write" },
  ],
};

/** All presets, keyed by domain. */
export const presets = {
  finance: financePolicy,
  infra: infraPolicy,
  comms: commsPolicy,
} as const;

/**
 * Combine several {@link PolicyConfig}s into one. Later configs win on exact
 * `tools` keys; `patterns` are concatenated in order (so earlier configs match
 * first); `version`/`defaults` take the last value that sets them.
 *
 * @example
 * const classify = classifierFromConfig(
 *   mergePolicies(presets.infra, presets.comms, myOwnPolicy),
 * );
 */
export function mergePolicies(...configs: readonly PolicyConfig[]): PolicyConfig {
  const tools: Record<string, PolicyRule> = {};
  const patterns: PolicyPattern[] = [];
  let version: number | undefined;
  let defaults: PolicyConfig["defaults"] | undefined;

  for (const config of configs) {
    if (config.version !== undefined) version = config.version;
    if (config.defaults !== undefined) defaults = config.defaults;
    if (config.tools) Object.assign(tools, config.tools);
    if (config.patterns) patterns.push(...config.patterns);
  }

  return {
    tools,
    patterns,
    ...(version !== undefined ? { version } : {}),
    ...(defaults !== undefined ? { defaults } : {}),
  };
}
