import cron, { ScheduledTask } from "node-cron";
import { BugzillaClient } from "./bugzilla.js";
import { StateStore } from "./state.js";
import { WebhookBug, WebhookDeliveryStatus, WebhookSender } from "./webhook.js";

export interface CronRunResult {
  ranAt: string;
  ok: boolean;
  bugzillaVersion?: string;
  newBugs?: WebhookBug[];
  changedBugs?: WebhookBug[];
  changedBugsTruncated?: boolean;
  webhook?: {
    created: WebhookDeliveryStatus | null;
    changed: WebhookDeliveryStatus | null;
  };
  error?: string;
}

export interface CronStatus {
  schedule: string;
  running: boolean;
  lastRun: CronRunResult | null;
  webhook: {
    enabled: boolean;
    url?: string;
    secretSet: boolean;
    lastDelivery: WebhookDeliveryStatus | null;
  };
}

interface VersionResponse {
  version: string;
}

interface BugSearchResponse {
  bugs: WebhookBug[];
}

export class BugzillaCron {
  private task: ScheduledTask | null = null;
  private lastRun: CronRunResult | null = null;
  private lastRunTime: Date | null = null;
  private inFlight: Promise<CronRunResult> | null = null;
  private schedule: string;

  constructor(
    private readonly client: BugzillaClient,
    schedule: string,
    private readonly instanceUrl: string,
    private readonly webhook: WebhookSender,
    private readonly state: StateStore,
  ) {
    this.schedule = schedule;
    const persisted = this.state.load();
    if (persisted.lastRunTime) {
      const parsed = new Date(persisted.lastRunTime);
      if (!Number.isNaN(parsed.getTime())) this.lastRunTime = parsed;
    }
  }

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

  setSchedule(schedule: string): void {
    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron schedule: ${schedule}`);
    }
    this.schedule = schedule;
    if (this.task) {
      this.stop();
      this.start();
    }
  }

  getSchedule(): string {
    return this.schedule;
  }

  run(): Promise<CronRunResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRun().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async searchBugs(params: Record<string, unknown>): Promise<{
    bugs: WebhookBug[];
    truncated: boolean;
  }> {
    const limit = 100;
    const maxBugs = 1000;
    const bugs: WebhookBug[] = [];
    let truncated = false;
    let offset = 0;
    for (;;) {
      const search = (await this.client.get("/bug", {
        ...params,
        include_fields: "id,summary,status,creation_time,last_change_time",
        order: "bug_id",
        limit,
        offset,
      })) as BugSearchResponse;
      bugs.push(...search.bugs);
      if (search.bugs.length < limit) break;
      if (bugs.length >= maxBugs) {
        truncated = true;
        break;
      }
      offset += limit;
    }
    return { bugs, truncated };
  }

  private async doRun(): Promise<CronRunResult> {
    const ranAt = new Date().toISOString();
    console.log(`[cron] pinging Bugzilla at ${ranAt}`);
    try {
      const version = (await this.client.version()) as VersionResponse;
      const result: CronRunResult = {
        ranAt,
        ok: true,
        bugzillaVersion: version.version,
      };
      let deliveryOk = true;
      if (this.lastRunTime) {
        const sinceMs = this.lastRunTime.getTime();
        const { bugs, truncated } = await this.searchBugs({
          last_change_time: this.lastRunTime.toISOString(),
        });
        const newBugs = bugs.filter(
          (bug) => bug.creation_time && new Date(bug.creation_time).getTime() >= sinceMs,
        );
        const newBugIds = new Set(newBugs.map((bug) => bug.id));
        const changedBugs = bugs.filter((bug) => !newBugIds.has(bug.id));
        result.newBugs = newBugs;
        result.changedBugs = changedBugs;
        result.changedBugsTruncated = truncated;
        console.log(
          `[cron] since last run: ${newBugs.length} new bug(s), ${changedBugs.length} changed bug(s)`,
        );
        if (this.webhook.enabled) {
          const created = newBugs.length
            ? await this.webhook.send("bug.created", this.instanceUrl, newBugs)
            : null;
          const changed = changedBugs.length
            ? await this.webhook.send("bug.changed", this.instanceUrl, changedBugs)
            : null;
          result.webhook = { created, changed };
          deliveryOk = (created?.ok ?? true) && (changed?.ok ?? true);
        }
      }
      this.lastRun = result;
      // Advance the watermark only when delivery succeeded (or was not needed),
      // so failed webhook deliveries are retried on the next run. When the
      // search was truncated, advance only to the latest fetched change so the
      // un-fetched bugs are picked up on the next run.
      if (deliveryOk) {
        const watermark = result.changedBugsTruncated
          ? this.maxLastChangeTime(result) ?? ranAt
          : ranAt;
        this.lastRunTime = new Date(watermark);
        this.state.save({ lastRunTime: this.lastRunTime.toISOString() });
      }
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

  private maxLastChangeTime(result: CronRunResult): string | null {
    let max: string | null = null;
    for (const bug of [...(result.newBugs ?? []), ...(result.changedBugs ?? [])]) {
      if (bug.last_change_time && (!max || bug.last_change_time > max)) {
        max = bug.last_change_time;
      }
    }
    return max;
  }

  status(): CronStatus {
    return {
      schedule: this.schedule,
      running: this.task !== null,
      lastRun: this.lastRun,
      webhook: {
        enabled: this.webhook.enabled,
        url: this.webhook.url,
        secretSet: this.webhook.secretSet,
        lastDelivery: this.webhook.lastDelivery,
      },
    };
  }
}
