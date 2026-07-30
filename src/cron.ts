import cron, { ScheduledTask } from "node-cron";
import { BugzillaClient } from "./bugzilla.js";

export interface CronRunResult {
  ranAt: string;
  ok: boolean;
  bugzillaVersion?: string;
  changedBugs?: { id: number; summary: string; status: string; last_change_time: string }[];
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
    this.task = cron.schedule(this.schedule, () => {
      void this.run();
    });
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
        const search = (await this.client.get("/bug", {
          last_change_time: this.lastRunTime.toISOString(),
          include_fields: "id,summary,status,last_change_time",
          limit: 100,
        })) as BugSearchResponse;
        result.changedBugs = search.bugs;
        console.log(`[cron] ${search.bugs.length} bug(s) changed since last run`);
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
      this.lastRunTime = new Date(ranAt);
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
