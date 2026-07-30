export interface Config {
  bugzillaBaseUrl: string;
  bugzillaApiKey: string;
  mcpAuthToken: string | undefined;
  cronSchedule: string;
  port: number;
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
  return {
    bugzillaBaseUrl: bugzillaBaseUrl.replace(/\/+$/, ""),
    bugzillaApiKey,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN,
    cronSchedule: process.env.CRON_SCHEDULE ?? "0 9 * * *",
    port: Number(process.env.PORT ?? 3000),
  };
}
