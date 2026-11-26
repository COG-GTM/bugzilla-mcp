import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BugzillaClient } from "../src/bugzilla.ts";
import { BugzillaCron } from "../src/cron.ts";
import { StateStore } from "../src/state.ts";
import { WebhookSender } from "../src/webhook.ts";

class FakeClient extends BugzillaClient {
  calls: string[] = [];
  constructor(
    private readonly versionFn: () => Promise<unknown>,
    private readonly searchFn: () => Promise<unknown>,
  ) {
    super({ baseUrl: "http://bugzilla.invalid", apiKey: "k" });
  }
  override version(): Promise<unknown> {
    this.calls.push("version");
    return this.versionFn();
  }
  override get(p: string): Promise<unknown> {
    this.calls.push(`get ${p}`);
    return this.searchFn();
  }
}

function makeCron(client: BugzillaClient): BugzillaCron {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-cron-"));
  const state = new StateStore(path.join(dir, "state.json"));
  state.save({ lastRunTime: "2026-01-01T00:00:00.000Z" });
  const webhook = new WebhookSender({ enabled: false });
  return new BugzillaCron(client, "* * * * *", "http://bugzilla.invalid", webhook, state);
}

test("cron starts the bug search without waiting for the version ping", async () => {
  let releaseVersion!: () => void;
  const versionGate = new Promise<void>((resolve) => (releaseVersion = resolve));
  const client = new FakeClient(
    async () => {
      await versionGate;
      return { version: "5.2" };
    },
    async () => ({
      bugs: [{ id: 1, summary: "s", status: "NEW", creation_time: "2026-02-01T00:00:00Z" }],
    }),
  );
  const run = makeCron(client).run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.calls, ["version", "get /bug"]);
  releaseVersion();
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(result.bugzillaVersion, "5.2");
  assert.deepEqual(result.newBugs?.map((b) => b.id), [1]);
});

test("cron reports the version error when both requests fail", async () => {
  const client = new FakeClient(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("version down");
    },
    async () => {
      throw new Error("search down");
    },
  );
  const result = await makeCron(client).run();
  assert.equal(result.ok, false);
  assert.equal(result.error, "version down");
});

test("cron reports the search error when only the search fails", async () => {
  const client = new FakeClient(
    async () => ({ version: "5.2" }),
    async () => {
      throw new Error("search down");
    },
  );
  const result = await makeCron(client).run();
  assert.equal(result.ok, false);
  assert.equal(result.error, "search down");
});

test("a failed version ping waits for the in-flight search before the run ends", async () => {
  let releaseSearch!: () => void;
  const searchGate = new Promise<void>((resolve) => (releaseSearch = resolve));
  let searchDone = false;
  const client = new FakeClient(
    async () => {
      throw new Error("version down");
    },
    async () => {
      await searchGate;
      searchDone = true;
      return { bugs: [] };
    },
  );
  const cron = makeCron(client);
  const run = cron.run();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cron.run(), run, "run should still be in flight while the search is pending");
  releaseSearch();
  const result = await run;
  assert.equal(searchDone, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, "version down");
});
