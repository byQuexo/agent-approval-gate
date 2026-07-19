import assert from "node:assert/strict";
import { test } from "node:test";
import { classifierFromYaml, parsePolicy } from "../src/yaml.js";

const YAML = `
version: 1
defaults:
  unlisted: write
tools:
  search_incidents:
    sensitivity: read
  delete_service:
    sensitivity: write
    destructive: true
    label: Delete service
patterns:
  - match: "*_incident"
    sensitivity: write
`;

const call = (name: string) => ({ id: name, name, args: {} });

test("parsePolicy parses and validates YAML", () => {
  const cfg = parsePolicy(YAML);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.tools?.search_incidents?.sensitivity, "read");
});

test("classifierFromYaml produces a working classifier", () => {
  const classify = classifierFromYaml(YAML);
  assert.equal(classify(call("search_incidents")).sensitivity, "read");
  assert.equal(classify(call("delete_service")).destructive, true);
  assert.equal(classify(call("ack_incident")).sensitivity, "write"); // *_incident
  assert.equal(classify(call("unknown_tool")).sensitivity, "write"); // unlisted: write
});

test("classifierFromYaml throws on malformed policy", () => {
  assert.throws(() => classifierFromYaml("tools:\n  foo:\n    sensitivity: nope\n"));
});
