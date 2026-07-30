# bugzilla-mcp

MCP (Model Context Protocol) server for managing Bugzilla tickets and projects,
served over Express with a built-in cron job that pings Bugzilla on a schedule.

Targets the [Bugzilla 5.2 REST API](https://bugzilla.readthedocs.io/en/5.2/api/index.html).

## Features

- **MCP over Streamable HTTP** at `POST /mcp` (stateless; works with any MCP client)
- **15 tools** covering bugs, comments, attachments, products, components, and field metadata
- **Cron job** that pings Bugzilla at a preconfigured time and polls for changed bugs
- **Dockerized** (multi-stage build, non-root user, docker-compose)

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

Note: Bugzilla has no delete-bug API; closing/resolving is done via `update_bug`
(e.g. `status=RESOLVED`, `resolution=FIXED`).

## HTTP Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP endpoint |
| `GET /health` | Liveness check |
| `GET /cron/status` | Cron schedule, last run time/result |
| `POST /cron/run` | Trigger the cron job manually |

`/mcp` and `/cron/*` require `Authorization: Bearer <MCP_AUTH_TOKEN>` when
`MCP_AUTH_TOKEN` is set.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
| --- | --- | --- |
| `BUGZILLA_BASE_URL` | yes | Bugzilla instance URL, e.g. `https://bugzilla.example.com` |
| `BUGZILLA_API_KEY` | yes | API key from Bugzilla Preferences → API Keys |
| `MCP_AUTH_TOKEN` | no | Bearer token protecting `/mcp` and `/cron/*` |
| `CRON_SCHEDULE` | no | Cron expression, evaluated in UTC (default `0 9 * * *` = daily 09:00 UTC) |
| `PORT` | no | Listen port (default 3000) |

The API key is sent as the `X-BUGZILLA-API-KEY` header on every Bugzilla request.

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
2. Polls `GET /rest/bug?last_change_time=<lastRun>` for bugs changed since the
   previous run (skipped on the first run since there is no baseline).
3. Logs results and stores the last result in memory, visible at `GET /cron/status`.

## Connecting an MCP Client

Point any Streamable-HTTP-capable MCP client at `http://<host>:3000/mcp`, with
header `Authorization: Bearer <MCP_AUTH_TOKEN>` if configured.
