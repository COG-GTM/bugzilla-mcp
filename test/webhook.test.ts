import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { signPayload, WebhookSender } from "../src/webhook.ts";
import { StateStore } from "../src/state.ts";

function fakeFetch(responses: (() => Response | Error)[]): {
  fetchFn: typeof fetch;
  calls: { url: string; body: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    const result = next();
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { fetchFn, calls };
}

test("webhook sends signed bug.created payload", async () => {
  const { fetchFn, calls } = fakeFetch([() => new Response("{}", { status: 200 })]);
  const sender = new WebhookSender(
    { url: "https://hook.example/x", secret: "s3cret", enabled: true },
    fetchFn,
    [],
  );
  const status = await sender.send("bug.created", "https://bz.example", [
    { id: 17, summary: "new bug", status: "CONFIRMED" },
  ]);
  assert.equal(status?.ok, true);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.event, "bug.created");
  assert.equal(payload.bugs[0].id, 17);
  const expected =
    "sha256=" + createHmac("sha256", "s3cret").update(calls[0].body).digest("hex");
  assert.equal(calls[0].headers["X-Webhook-Signature"], expected);
  assert.equal(signPayload("s3cret", calls[0].body), expected);
});

test("webhook retries on failure and reports final status", async () => {
  const { fetchFn, calls } = fakeFetch([
    () => new Error("connect ECONNREFUSED"),
    () => new Response("bad", { status: 500 }),
    () => new Response("{}", { status: 200 }),
  ]);
  const sender = new WebhookSender(
    { url: "https://hook.example/x", enabled: true },
    fetchFn,
    [0, 0],
  );
  const status = await sender.send("bug.changed", "https://bz.example", []);
  assert.equal(status?.ok, true);
  assert.equal(status?.attempts, 3);
  assert.equal(calls.length, 3);
});

test("webhook disabled or without URL sends nothing", async () => {
  const { fetchFn, calls } = fakeFetch([]);
  const noUrl = new WebhookSender({ enabled: true }, fetchFn, []);
  const disabled = new WebhookSender(
    { url: "https://hook.example/x", enabled: false },
    fetchFn,
    [],
  );
  assert.equal(await noUrl.send("webhook.test", "i", []), null);
  assert.equal(await disabled.send("webhook.test", "i", []), null);
  assert.equal(calls.length, 0);
});

test("state store persists and merges patches", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bzmcp-")), "state.json");
  const store = new StateStore(file);
  assert.deepEqual(store.load(), {});
  store.save({ lastRunTime: "2026-01-01T00:00:00.000Z" });
  store.save({ cronSchedule: "*/5 * * * *", webhookUrl: "https://hook.example/x" });
  const loaded = new StateStore(file).load();
  assert.equal(loaded.lastRunTime, "2026-01-01T00:00:00.000Z");
  assert.equal(loaded.cronSchedule, "*/5 * * * *");
  store.save({ webhookUrl: undefined });
  assert.equal(new StateStore(file).load().webhookUrl, undefined);
});
