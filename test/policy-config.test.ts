import assert from "node:assert/strict";
import { test } from "node:test";
import { classifierFromConfig, PolicyConfigError, validatePolicy } from "../src/index.js";
import type { PolicyConfig } from "../src/index.js";

const call = (name: string) => ({ id: name, name, args: {} });

const config: PolicyConfig = {
  version: 1,
  defaults: { unlisted: "heuristic" },
  tools: {
    search_incidents: { sensitivity: "read" },
    ack_incident: { sensitivity: "write", label: "Acknowledge incident" },
    delete_service: { sensitivity: "write", destructive: true, label: "Delete service" },
  },
  patterns: [
    { match: "drop_*", sensitivity: "write", destructive: true },
    { match: "*_incident", sensitivity: "write" },
  ],
};

test("exact tool match wins", () => {
  const classify = classifierFromConfig(config);
  assert.equal(classify(call("search_incidents")).sensitivity, "read");
  assert.deepEqual(classify(call("delete_service")), {
    sensitivity: "write",
    destructive: true,
    label: "Delete service",
  });
});

test("patterns match after exact, in order", () => {
  const classify = classifierFromConfig(config);
  assert.equal(classify(call("drop_table")).destructive, true);
  // matches "*_incident"
  assert.equal(classify(call("resolve_incident")).sensitivity, "write");
});

test("unlisted falls back to heuristic by default", () => {
  const classify = classifierFromConfig(config);
  assert.equal(classify(call("list_users")).sensitivity, "read"); // heuristic: read
  assert.equal(classify(call("update_thing")).sensitivity, "write"); // heuristic: write
});

test("unlisted: write gates every unknown tool", () => {
  const classify = classifierFromConfig({ defaults: { unlisted: "write" } });
  assert.equal(classify(call("anything_at_all")).sensitivity, "write");
});

test("omitted sensitivity is fail-safe (write)", () => {
  const classify = classifierFromConfig({ tools: { mystery: {} } });
  assert.equal(classify(call("mystery")).sensitivity, "write");
});

test("validatePolicy rejects a bad sensitivity with a precise path", () => {
  assert.throws(
    () => validatePolicy({ tools: { foo: { sensitivity: "maybe" } } }),
    (err: unknown) => {
      assert.ok(err instanceof PolicyConfigError);
      assert.match(err.message, /tools\.foo\.sensitivity/);
      return true;
    },
  );
});

test("validatePolicy rejects a pattern without match", () => {
  assert.throws(
    () => validatePolicy({ patterns: [{ sensitivity: "write" }] }),
    (err: unknown) => err instanceof PolicyConfigError,
  );
});
