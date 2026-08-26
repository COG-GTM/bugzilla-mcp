import fs from "node:fs";
import path from "node:path";

export interface PersistedState {
  lastRunTime?: string;
  creationCutoffTime?: string;
  cronSchedule?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookEnabled?: boolean;
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as PersistedState;
      }
      return {};
    } catch {
      return {};
    }
  }

  save(patch: Partial<PersistedState>): PersistedState {
    const next = { ...this.load(), ...patch };
    for (const key of Object.keys(next) as (keyof PersistedState)[]) {
      if (next[key] === undefined) delete next[key];
    }
    fs.mkdirSync(path.dirname(path.resolve(this.filePath)), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    return next;
  }
}
