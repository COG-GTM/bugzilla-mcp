import { Express, NextFunction, Request, Response } from "express";
import cron from "node-cron";
import { BugzillaCron } from "./cron.js";
import { StateStore } from "./state.js";
import { WebhookSender } from "./webhook.js";

const SETTINGS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bugzilla-mcp settings</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
fieldset { margin-bottom: 1.5rem; }
label { display: block; margin: 0.5rem 0 0.15rem; }
input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 0.3rem; }
button { margin-top: 0.75rem; margin-right: 0.5rem; }
pre { background: #f4f4f4; padding: 0.5rem; overflow-x: auto; }
.msg { margin-top: 0.5rem; }
.err { color: #b00020; }
.ok { color: #1a7f37; }
</style>
</head>
<body>
<h1>bugzilla-mcp settings</h1>
<fieldset>
<legend>Auth</legend>
<label for="token">MCP auth token (Bearer)</label>
<input type="password" id="token" autocomplete="off">
<button id="load">Load settings</button>
<div class="msg" id="authmsg"></div>
</fieldset>
<fieldset>
<legend>Cron</legend>
<label for="interval">Poll every (minutes)</label>
<input type="number" id="interval" min="1" max="59" step="1">
<button id="save-cron">Save schedule</button>
<button id="run-now">Run now</button>
<div class="msg" id="cronmsg"></div>
</fieldset>
<fieldset>
<legend>Webhook</legend>
<label for="url">Webhook URL</label>
<input type="text" id="url" placeholder="https://example.com/hook">
<label for="secret">Webhook secret (write-only; leave blank to keep current)</label>
<input type="password" id="secret" autocomplete="off">
<label><input type="checkbox" id="enabled"> Enabled</label>
<button id="save-webhook">Save webhook</button>
<button id="test-webhook">Send test event</button>
<div class="msg" id="hookmsg"></div>
</fieldset>
<fieldset>
<legend>Status</legend>
<pre id="status">(load settings to view)</pre>
</fieldset>
<script>
const $ = (id) => document.getElementById(id);
function headers() {
  return { "Content-Type": "application/json", "Authorization": "Bearer " + $("token").value };
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function show(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}
function cronToMinutes(schedule) {
  const m = /^\\*\\/(\\d+) \\* \\* \\* \\*$/.exec(schedule);
  return m ? m[1] : "";
}
async function refresh() {
  const cfg = await api("GET", "/settings/config");
  $("interval").value = cronToMinutes(cfg.cronSchedule);
  $("url").value = cfg.webhookUrl || "";
  $("enabled").checked = !!cfg.webhookEnabled;
  $("status").textContent = JSON.stringify(cfg.status, null, 2);
}
$("load").onclick = async () => {
  try { await refresh(); show("authmsg", "Loaded.", true); }
  catch (e) { show("authmsg", e.message, false); }
};
$("save-cron").onclick = async () => {
  try {
    const minutes = parseInt($("interval").value, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
      throw new Error("Enter a whole number of minutes between 1 and 59");
    }
    await api("PUT", "/settings/config", { cronSchedule: "*/" + minutes + " * * * *" });
    await refresh(); show("cronmsg", "Schedule saved.", true);
  } catch (e) { show("cronmsg", e.message, false); }
};
$("run-now").onclick = async () => {
  try {
    const r = await api("POST", "/cron/run");
    await refresh(); show("cronmsg", "Run finished: " + (r.ok ? "ok" : r.error), r.ok);
  } catch (e) { show("cronmsg", e.message, false); }
};
$("save-webhook").onclick = async () => {
  try {
    const body = { webhookUrl: $("url").value, webhookEnabled: $("enabled").checked };
    if ($("secret").value) body.webhookSecret = $("secret").value;
    await api("PUT", "/settings/config", body);
    $("secret").value = "";
    await refresh(); show("hookmsg", "Webhook settings saved.", true);
  } catch (e) { show("hookmsg", e.message, false); }
};
$("test-webhook").onclick = async () => {
  try {
    const r = await api("POST", "/settings/test-webhook");
    await refresh();
    show("hookmsg", r.delivered ? "Test event delivered." : "Delivery failed: " + (r.error || "unknown"), r.delivered);
  } catch (e) { show("hookmsg", e.message, false); }
};
</script>
</body>
</html>
`;

export function registerSettingsRoutes(
  app: Express,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  cronJob: BugzillaCron,
  webhook: WebhookSender,
  state: StateStore,
  instanceUrl: string,
  authConfigured: boolean,
): void {
  const requireConfiguredAuth = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!authConfigured) {
      res.status(403).json({
        error: "Settings changes are disabled because MCP_AUTH_TOKEN is not set",
      });
      return;
    }
    next();
  };

  app.get("/settings", (_req: Request, res: Response) => {
    res.type("html").send(SETTINGS_PAGE);
  });

  app.get("/settings/config", requireAuth, (_req: Request, res: Response) => {
    res.json({
      cronSchedule: cronJob.getSchedule(),
      webhookUrl: webhook.url ?? "",
      webhookEnabled: webhook.enabled,
      webhookSecretSet: webhook.secretSet,
      status: cronJob.status(),
    });
  });

  app.put("/settings/config", requireConfiguredAuth, requireAuth, (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "JSON object body required" });
      return;
    }
    const { cronSchedule, webhookUrl, webhookSecret, webhookEnabled } = body as {
      cronSchedule?: unknown;
      webhookUrl?: unknown;
      webhookSecret?: unknown;
      webhookEnabled?: unknown;
    };
    if (cronSchedule !== undefined) {
      if (typeof cronSchedule !== "string" || !cron.validate(cronSchedule)) {
        res.status(400).json({ error: `Invalid cron schedule: ${String(cronSchedule)}` });
        return;
      }
    }
    if (webhookUrl !== undefined) {
      if (typeof webhookUrl !== "string") {
        res.status(400).json({ error: "webhookUrl must be a string" });
        return;
      }
      if (webhookUrl !== "" && !/^https?:\/\//.test(webhookUrl)) {
        res.status(400).json({ error: "webhookUrl must be an http(s) URL" });
        return;
      }
    }
    if (webhookSecret !== undefined && typeof webhookSecret !== "string") {
      res.status(400).json({ error: "webhookSecret must be a string" });
      return;
    }
    if (webhookEnabled !== undefined && typeof webhookEnabled !== "boolean") {
      res.status(400).json({ error: "webhookEnabled must be a boolean" });
      return;
    }
    if (cronSchedule !== undefined) {
      cronJob.setSchedule(cronSchedule as string);
    }
    webhook.configure({
      ...(webhookUrl !== undefined ? { url: (webhookUrl as string) || undefined } : {}),
      ...(webhookSecret !== undefined ? { secret: (webhookSecret as string) || undefined } : {}),
      ...(webhookEnabled !== undefined ? { enabled: webhookEnabled as boolean } : {}),
    });
    state.save({
      ...(cronSchedule !== undefined ? { cronSchedule: cronSchedule as string } : {}),
      // Persist empty strings so a cleared value keeps overriding the
      // environment variable after a restart.
      ...(webhookUrl !== undefined ? { webhookUrl: webhookUrl as string } : {}),
      ...(webhookSecret !== undefined ? { webhookSecret: webhookSecret as string } : {}),
      ...(webhookEnabled !== undefined ? { webhookEnabled: webhookEnabled as boolean } : {}),
    });
    res.json({ ok: true });
  });

  app.post("/settings/test-webhook", requireConfiguredAuth, requireAuth, async (_req: Request, res: Response) => {
    if (!webhook.enabled) {
      res.status(400).json({ delivered: false, error: "Webhook is not enabled or has no URL" });
      return;
    }
    const status = await webhook.send("webhook.test", instanceUrl, []);
    res.json({ delivered: status?.ok ?? false, error: status?.error });
  });
}
