import cron, { ScheduledTask } from "node-cron";
import { BugzillaClient } from "./bugzilla.js";

export interface CronRunResult {
  ranAt: string;
  ok: boolean;
  bugzillaVersion?: string;
  changedBugs?: { id: number; summary: string; status: string; last_change_time: string }[];
  changedBugsTruncated?: boolean;
  error?: string;
}

export interface CronStatus {
  schedule: string;
  running: boolean;
  lastRun: CronRunResult | null;
}

interface VersionResponse {
  version: string;
}

interface BugSearchResponse {
  bugs: { id: number; summary: string; status: string; last_change_time: string }[];
}

export class BugzillaCron {
  private task: ScheduledTask | null = null;
  private lastRun: CronRunResult | null = null;
  private lastRunTime: Date | null = null;

  constructor(
    private readonly client: BugzillaClient,
    private readonly schedule: string,
  ) {}

  start(): void {
    if (!cron.validate(this.schedule)) {
      throw new Error(`Invalid CRON_SCHEDULE: ${this.schedule}`);
    }
    this.task = cron.schedule(
      this.schedule,
      () => {
        void this.run();
      },
      { timezone: "UTC" },
    );
    console.log(`[cron] scheduled Bugzilla ping: ${this.schedule}`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async run(): Promise<CronRunResult> {
    const ranAt = new Date().toISOString();
    console.log(`[cron] pinging Bugzilla at ${ranAt}`);
    try {
      const version = (await this.client.version()) as VersionResponse;
      const result: CronRunResult = {
        ranAt,
        ok: true,
        bugzillaVersion: version.version,
      };
      if (this.lastRunTime) {
        const limit = 100;
        const since = this.lastRunTime.toISOString();
        const bugs: BugSearchResponse["bugs"] = [];
        let offset = 0;
        for (;;) {
          const search = (await this.client.get("/bug", {
            last_change_time: since,
            include_fields: "id,summary,status,last_change_time",
            limit,
            offset,
          })) as BugSearchResponse;
          bugs.push(...search.bugs);
          if (search.bugs.length < limit || bugs.length >= 1000) {
            result.changedBugsTruncated = search.bugs.length === limit;
            break;
          }
          offset += limit;
        }
        result.changedBugs = bugs;
        console.log(`[cron] ${bugs.length} bug(s) changed since last run`);
      }
      this.lastRun = result;
      this.lastRunTime = new Date(ranAt);
      return result;
    } catch (err) {
      const result: CronRunResult = {
        ranAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      console.error(`[cron] ping failed: ${result.error}`);
      this.lastRun = result;
      return result;
    }
  }

  status(): CronStatus {
    return {
      schedule: this.schedule,
      running: this.task !== null,
      lastRun: this.lastRun,
    };
  }
}
