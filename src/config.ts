export interface Config {
  bugzillaBaseUrl: string;
  bugzillaApiKey: string;
  bugzillaAuthStyle: "header" | "query";
  mcpAuthToken: string | undefined;
  cronSchedule: string;
  port: number;
  webhookUrl: string | undefined;
  webhookSecret: string | undefined;
  stateFile: string;
}

export function loadConfig(): Config {
  const bugzillaBaseUrl = process.env.BUGZILLA_BASE_URL;
  const bugzillaApiKey = process.env.BUGZILLA_API_KEY;
  if (!bugzillaBaseUrl) {
    throw new Error("BUGZILLA_BASE_URL environment variable is required");
  }
  if (!bugzillaApiKey) {
    throw new Error("BUGZILLA_API_KEY environment variable is required");
  }
  const bugzillaAuthStyle = process.env.BUGZILLA_AUTH_STYLE?.trim() || "header";
  if (bugzillaAuthStyle !== "header" && bugzillaAuthStyle !== "query") {
    throw new Error(
      `Invalid BUGZILLA_AUTH_STYLE: ${bugzillaAuthStyle}. Expected "header" or "query"`,
    );
  }
  const portEnv = process.env.PORT?.trim();
  const port = portEnv ? Number(portEnv) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  return {
    bugzillaBaseUrl: bugzillaBaseUrl.replace(/\/+$/, ""),
    bugzillaApiKey,
    bugzillaAuthStyle,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN,
    cronSchedule: process.env.CRON_SCHEDULE ?? "0 9 * * *",
    port,
    webhookUrl: process.env.WEBHOOK_URL?.trim() || undefined,
    webhookSecret: process.env.WEBHOOK_SECRET || undefined,
    stateFile: process.env.STATE_FILE?.trim() || ".bugzilla-mcp-state.json",
  };
}
