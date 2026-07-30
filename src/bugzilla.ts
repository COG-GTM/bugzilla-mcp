export interface BugzillaClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class BugzillaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bugzillaCode?: number,
  ) {
    super(message);
    this.name = "BugzillaError";
  }
}

interface BugzillaErrorBody {
  error?: boolean;
  code?: number;
  message?: string;
}

export class BugzillaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: BugzillaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    query?: Record<string, unknown>,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const headers: Record<string, string> = {
      "X-BUGZILLA-API-KEY": this.apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BugzillaError(
        `Bugzilla returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`,
        res.status,
      );
    }
    const errBody = json as BugzillaErrorBody;
    if (!res.ok || errBody.error) {
      throw new BugzillaError(
        errBody.message ?? `Bugzilla request failed (HTTP ${res.status})`,
        res.status,
        errBody.code,
      );
    }
    return json;
  }

  get(path: string, query?: Record<string, unknown>): Promise<unknown> {
    return this.request("GET", path, query);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, undefined, body);
  }

  put(path: string, body: unknown): Promise<unknown> {
    return this.request("PUT", path, undefined, body);
  }

  version(): Promise<unknown> {
    return this.get("/version");
  }
}
