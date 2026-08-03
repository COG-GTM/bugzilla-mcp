import { timingSafeEqual } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { BugzillaClient } from "./bugzilla.js";
import { registerTools } from "./tools.js";
import { BugzillaCron } from "./cron.js";

const config = loadConfig();
const client = new BugzillaClient({
  baseUrl: config.bugzillaBaseUrl,
  apiKey: config.bugzillaApiKey,
});
const cronJob = new BugzillaCron(client, config.cronSchedule);

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "bugzilla-mcp", version: "0.1.0" });
  registerTools(server, client);
  return server;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.mcpAuthToken) {
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const provided = Buffer.from(match?.[1] ?? "");
  const expected = Buffer.from(config.mcpAuthToken);
  const equal = provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!equal) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  // Stateless mode: a fresh server/transport per request, no session tracking.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close().catch((err) => console.error("[mcp] transport close error:", err));
    server.close().catch((err) => console.error("[mcp] server close error:", err));
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", requireAuth, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/cron/status", requireAuth, (_req: Request, res: Response) => {
  res.json(cronJob.status());
});

app.post("/cron/run", requireAuth, async (_req: Request, res: Response) => {
  const result = await cronJob.run();
  res.status(result.ok ? 200 : 502).json(result);
});

app.use(
  (
    err: Error & { status?: number; statusCode?: number; type?: string },
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const rawStatus = err.status ?? err.statusCode;
    const status =
      typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600
        ? rawStatus
        : 500;
    const isParseError = err.type === "entity.parse.failed";
    console.error("[http] request error:", err);
    let message = "Internal server error";
    if (isParseError) {
      message = "Parse error";
    } else if (status < 500) {
      message = err.message || message;
    }
    let code = -32603;
    if (isParseError) {
      code = -32700;
    } else if (status < 500) {
      code = -32600;
    }
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    });
  },
);

if (!config.mcpAuthToken) {
  console.warn(
    "[warn] MCP_AUTH_TOKEN is not set: /mcp and /cron endpoints are UNAUTHENTICATED. Anyone who can reach this port has full Bugzilla access via the configured API key.",
  );
}

cronJob.start();
const httpServer = app.listen(config.port, () => {
  console.log(`bugzilla-mcp listening on port ${config.port}`);
  console.log(`  MCP endpoint:  POST /mcp`);
  console.log(`  Health check:  GET  /health`);
  console.log(`  Cron status:   GET  /cron/status`);
  console.log(`  Cron trigger:  POST /cron/run`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down`);
    cronJob.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => {
      httpServer.closeAllConnections();
      process.exit(0);
    }, 10_000).unref();
  });
}
