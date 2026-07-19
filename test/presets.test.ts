import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifierFromConfig,
  commsPolicy,
  financePolicy,
  infraPolicy,
  mergePolicies,
  presets,
} from "../src/index.js";

const call = (name: string) => ({ id: name, name, args: {} });

test("finance preset flags money movement", () => {
  const classify = classifierFromConfig(financePolicy);
  assert.equal(classify(call("transfer_funds")).destructive, true);
  assert.equal(classify(call("execute_trade")).sensitivity, "write");
  assert.equal(classify(call("deposit_check")).destructive, undefined); // write, not destructive
});

test("infra preset flags teardown as destructive, provisioning as write", () => {
  const classify = classifierFromConfig(infraPolicy);
  assert.equal(classify(call("delete_cluster")).destructive, true);
  assert.equal(classify(call("run_command")).destructive, true);
  assert.equal(classify(call("deploy_service")).sensitivity, "write");
  assert.equal(classify(call("deploy_service")).destructive, undefined);
});

test("comms preset gates sending; broadcast is destructive", () => {
  const classify = classifierFromConfig(commsPolicy);
  assert.equal(classify(call("send_email")).sensitivity, "write");
  assert.equal(classify(call("broadcast_alert")).destructive, true);
});

test("presets record exposes all three", () => {
  assert.deepEqual(Object.keys(presets).sort(), ["comms", "finance", "infra"]);
});

test("mergePolicies concatenates patterns and layers a custom tool map", () => {
  const merged = mergePolicies(presets.infra, presets.comms, {
    tools: { get_status: { sensitivity: "read" } },
    defaults: { unlisted: "write" },
  });
  const classify = classifierFromConfig(merged);

  assert.equal(classify(call("delete_cluster")).destructive, true); // from infra
  assert.equal(classify(call("send_email")).sensitivity, "write"); // from comms
  assert.equal(classify(call("get_status")).sensitivity, "read"); // custom tool
  assert.equal(classify(call("anything_else")).sensitivity, "write"); // unlisted default
});

test("earlier patterns win on overlap (merge order)", () => {
  // infra's delete_* (destructive) precedes a looser custom delete rule
  const merged = mergePolicies(presets.infra, {
    patterns: [{ match: "delete_note", sensitivity: "write" }],
  });
  // delete_* matches first -> destructive stays true
  assert.equal(classifierFromConfig(merged)(call("delete_note")).destructive, true);
});
