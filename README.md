# bugzilla-mcp

MCP (Model Context Protocol) server for managing Bugzilla tickets and projects,
served over Express with a built-in cron job that pings Bugzilla on a schedule.

Targets the [Bugzilla 5.2 REST API](https://bugzilla.readthedocs.io/en/5.2/api/index.html).

## Features

- **MCP over Streamable HTTP** at `POST /mcp` (stateless; works with any MCP client)
- **15 tools** covering bugs, comments, attachments, products, components, and field metadata
- **Cron job** that pings Bugzilla at a preconfigured time and polls for new and changed bugs
- **Outgoing webhook** — the cron job POSTs signed `bug.created` / `bug.changed` events to a configurable URL
- **Settings page** at `GET /settings` for configuring the cron schedule and webhook from the browser
- **Dockerized** (multi-stage build, non-root user, docker-compose)

## Quick Start

Requires Node.js 20+ and network access to your Bugzilla instance.

```bash
git clone https://github.com/COG-GTM/bugzilla-mcp
cd bugzilla-mcp
npm install
npm run build
cp .env.example .env
```

Edit `.env`:

```dotenv
BUGZILLA_BASE_URL=https://your-bugzilla.example.com/
BUGZILLA_API_KEY=<key from Bugzilla Preferences -> API Keys>
# Only for Bugzilla 5.0.x, which ignores the auth header (default: header):
BUGZILLA_AUTH_STYLE=query
# Any random string of your choosing, e.g. `openssl rand -hex 32`:
MCP_AUTH_TOKEN=<random token>
```

Then start it:

```bash
npm run start:local
```

- MCP clients connect to `http://<host>:3000/mcp` with header
  `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- The settings page is at `http://<host>:3000/settings` (enter the same token).
- Cron/webhook settings persist in `.bugzilla-mcp-state.json` next to the app
  (override the path with `STATE_FILE`).

For production: use a dedicated least-privilege Bugzilla service account for
the API key, always set `MCP_AUTH_TOKEN` (settings writes are refused without
it), and terminate TLS in front of the server if it is reachable beyond
localhost.

## MCP Tools

| Tool | Bugzilla endpoint |
| --- | --- |
| `search_bugs` | `GET /rest/bug` |
| `get_bug` | `GET /rest/bug/(id_or_alias)` |
| `create_bug` | `POST /rest/bug` |
| `update_bug` | `PUT /rest/bug/(id_or_alias)` |
| `get_bug_history` | `GET /rest/bug/(id)/history` |
| `get_comments` | `GET /rest/bug/(id)/comment` |
| `add_comment` | `POST /rest/bug/(id)/comment` |
| `list_attachments` | `GET /rest/bug/(id)/attachment` |
| `create_attachment` | `POST /rest/bug/(id)/attachment` |
| `list_products` | `GET /rest/product_{accessible,enterable,selectable}` |
| `get_product` | `GET /rest/product/(id_or_name)` |
| `create_product` | `POST /rest/product` |
| `update_product` | `PUT /rest/product/(id_or_name)` |
| `create_component` | `POST /rest/component` |
| `get_field_values` | `GET /rest/field/bug/(field)/values` |

`search_bugs`, `create_bug`, and `update_bug` accept an optional `custom_fields`
object for Bugzilla custom fields, such as
`custom_fields: {"cf_severity_class": "Sev1-Critical"}` when filtering or
setting a mandatory field. Per Bugzilla's REST contract, an array value for a
multi-select custom field replaces the field's whole value — unlike `keywords`
and `cc`, custom fields have no incremental `{add, remove}` form.

Note: Bugzilla has no delete-bug API; closing/resolving is done via `update_bug`
(e.g. `status=RESOLVED`, `resolution=FIXED`).

## HTTP Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP endpoint |
| `GET /health` | Liveness check |
| `GET /cron/status` | Cron schedule, last run time/result |
| `POST /cron/run` | Trigger the cron job manually |
| `GET /settings` | HTML settings page (cron schedule + webhook) |
| `GET /settings/config` | Current cron/webhook settings and status (JSON) |
| `PUT /settings/config` | Update cron schedule and/or webhook settings |
| `POST /settings/test-webhook` | Fire a signed `webhook.test` event at the configured URL |

`/mcp`, `/cron/*`, and the `/settings` JSON API require
`Authorization: Bearer <MCP_AUTH_TOKEN>` when `MCP_AUTH_TOKEN` is set. The
settings page itself is static HTML; it asks for the token and sends it as the
Bearer header on every API call.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
| --- | --- | --- |
| `BUGZILLA_BASE_URL` | yes | Bugzilla instance URL, e.g. `https://bugzilla.example.com` |
| `BUGZILLA_API_KEY` | yes | API key from Bugzilla Preferences → API Keys |
| `BUGZILLA_AUTH_STYLE` | no | `header` (default) sends the key as a header; set to `query` for Bugzilla 5.0.x, which ignores the header |
| `MCP_AUTH_TOKEN` | no | Bearer token protecting `/mcp` and `/cron/*` |
| `CRON_SCHEDULE` | no | Cron expression, evaluated in UTC (default `0 9 * * *` = daily 09:00 UTC) |
| `PORT` | no | Listen port (default 3000) |
| `WEBHOOK_URL` | no | URL the cron job POSTs `bug.created` / `bug.changed` events to |
| `WEBHOOK_SECRET` | no | HMAC-SHA256 key; adds an `X-Webhook-Signature: sha256=<hmac>` header |
| `STATE_FILE` | no | JSON file persisting the cron watermark and settings-page overrides (default `.bugzilla-mcp-state.json`) |

Values changed through the settings page are persisted in `STATE_FILE` and
override the corresponding environment variables on restart.

The API key is sent on every Bugzilla request as the `X-BUGZILLA-API-KEY` header,
or as an `api_key` query parameter when `BUGZILLA_AUTH_STYLE=query`.

`BUGZILLA_AUTH_STYLE=query` puts the key in the request URL, where intermediary
proxy and access logs may record it. Bugzilla 5.0.x ignores the header and
accepts no other authentication, so use `query` only for those instances, with a
dedicated least-privilege service account and periodic key rotation.

## Running

### Docker (recommended)

```bash
cp .env.example .env   # then edit
docker compose up --build
```

### Local

```bash
npm install
npm run build
npm run start:local   # loads .env via node --env-file; or: npm run dev
```

`npm start` reads configuration from the process environment only (used in the
Docker image); use `start:local` or `dev` to load a local `.env` file.

## Cron Job

At each scheduled tick the job:

1. Calls `GET /rest/version` as a health check.
2. Polls `GET /rest/bug?last_change_time=<lastRun>` for bugs touched since the
   previous run (skipped on the first run since there is no baseline) and splits
   them into new bugs (`creation_time` ≥ last run) and changed bugs.
3. Delivers webhook events (see below) when a webhook URL is configured.
4. Logs results and stores the last result in memory, visible at `GET /cron/status`.

The last-run watermark is persisted in `STATE_FILE`, so a restart does not skip
bugs filed while the server was down. The watermark only advances after webhook
delivery succeeds (or when no webhook is configured), so failed deliveries are
retried on the next run (at-least-once semantics — receivers should dedupe by
bug `id`).

## Webhook

When `WEBHOOK_URL` is set (or configured via the settings page), each cron run
POSTs one batched JSON payload per event type:

```json
{
  "event": "bug.created",
  "instance": "https://bugzilla.example.com",
  "firedAt": "2026-01-01T09:00:00.000Z",
  "bugs": [
    { "id": 17, "summary": "...", "status": "CONFIRMED",
      "creation_time": "...", "last_change_time": "..." }
  ]
}
```

`bug.changed` uses the same shape. Failed deliveries retry 3 times with
exponential backoff (1s/5s/25s); the last delivery status is visible at
`GET /cron/status` and on the settings page.

If `WEBHOOK_SECRET` is set, each request carries
`X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Verify it
receiver-side, e.g. in Node:

```js
const expected = "sha256=" +
  crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
```

The webhook only ever sees bugs visible to the configured `BUGZILLA_API_KEY`
identity — group-restricted bugs the account cannot read are never delivered.

## Settings Page

`GET /settings` serves a plain-HTML page (no build step, no framework) to:

- view and edit the polling interval in minutes (converted to a cron
  expression and applied live),
- set the webhook URL, secret (write-only — never displayed back), and
  enabled flag,
- trigger **Run now** and **Send test event**,
- inspect the last run and last webhook delivery status.

Enter the `MCP_AUTH_TOKEN` at the top of the page; without it the JSON API
rejects every call. Changes persist to `STATE_FILE` (written mode 0600).

## Connecting an MCP Client

Point any Streamable-HTTP-capable MCP client at `http://<host>:3000/mcp`, with
header `Authorization: Bearer <MCP_AUTH_TOKEN>` if configured.
