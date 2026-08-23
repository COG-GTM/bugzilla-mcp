import assert from "node:assert/strict";
import test from "node:test";
import { BugzillaClient } from "../src/bugzilla.ts";
import { customFieldsSchema, mergeCustomFields } from "../src/tools.ts";

test("custom fields accept supported values and reject invalid keys", () => {
  const valid = customFieldsSchema.safeParse({
    cf_severity_class: "Sev1-Critical",
    cf_impact_score: 4,
    cf_customer_visible: true,
    cf_related_values: ["one", "two"],
  });
  assert.equal(valid.success, true);

  const invalid = customFieldsSchema.safeParse({
    "severity-class": "Sev1-Critical",
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.match(
      invalid.error.issues[0]?.message ?? "",
      /Invalid custom field key "severity-class"/,
    );
  }
});

test("custom fields merge without overriding explicitly typed fields", () => {
  assert.deepEqual(
    mergeCustomFields(
      { cf_severity_class: "Sev1-Critical", cf_limit: 10 },
      { limit: 20, offset: 0 },
    ),
    {
      cf_severity_class: "Sev1-Critical",
      cf_limit: 10,
      limit: 20,
      offset: 0,
    },
  );
  assert.deepEqual(mergeCustomFields({}, { limit: 20, offset: 0 }), {
    limit: 20,
    offset: 0,
  });
});

test("Bugzilla queries serialize custom-field arrays as repeated parameters", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ bugs: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new BugzillaClient({
      baseUrl: "https://bugzilla.example.test",
      apiKey: "test-key",
      authStyle: "query",
    });
    await client.get("/bug", {
      cf_severity_class: ["Sev1-Critical", "Sev2-High"],
      limit: 20,
      offset: 0,
    });

    const url = new URL(requestedUrl);
    assert.deepEqual(url.searchParams.getAll("cf_severity_class"), [
      "Sev1-Critical",
      "Sev2-High",
    ]);
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("offset"), "0");
    assert.equal(url.searchParams.get("api_key"), "test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
