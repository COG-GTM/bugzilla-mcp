import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BugzillaClient } from "./bugzilla.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const customFieldKeyPattern = /^cf_[A-Za-z0-9_]+$/;
export const customFieldsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
  .superRefine((customFields, ctx) => {
    for (const key of Object.keys(customFields)) {
      if (!customFieldKeyPattern.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid custom field key "${key}": must match /^cf_[A-Za-z0-9_]+$/`,
          path: [key],
        });
      }
    }
  });

export function mergeCustomFields(
  customFields: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { ...customFields, ...fields };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

export function registerTools(server: McpServer, client: BugzillaClient): void {
  server.tool(
    "search_bugs",
    "Search for bugs in Bugzilla. All parameters are optional filters.",
    {
      product: z.string().optional().describe("Product name"),
      component: z.string().optional().describe("Component name"),
      status: z.string().optional().describe("Bug status (e.g. NEW, RESOLVED)"),
      resolution: z.string().optional().describe("Resolution (e.g. FIXED)"),
      assigned_to: z.string().optional().describe("Assignee email or login"),
      creator: z.string().optional().describe("Reporter email or login"),
      summary: z.string().optional().describe("Substring match on summary"),
      priority: z.string().optional(),
      severity: z.string().optional(),
      last_change_time: z
        .string()
        .optional()
        .describe("ISO 8601 datetime; bugs changed at/after this time"),
      limit: z.number().int().positive().max(100).default(20),
      offset: z.number().int().min(0).default(0),
      custom_fields: customFieldsSchema.optional(),
    },
    async ({ custom_fields, ...args }) =>
      run(() => client.get("/bug", mergeCustomFields(custom_fields, args))),
  );

  server.tool(
    "get_bug",
    "Get a bug by ID or alias.",
    {
      id_or_alias: z.string().describe("Bug ID or alias"),
    },
    async ({ id_or_alias }) => run(() => client.get(`/bug/${encodeURIComponent(id_or_alias)}`)),
  );

  server.tool(
    "create_bug",
    "Create a new bug (ticket).",
    {
      product: z.string(),
      component: z.string(),
      summary: z.string(),
      version: z.string().describe("Product version the bug was found in"),
      description: z.string().optional().describe("Initial comment"),
      op_sys: z.string().optional(),
      platform: z.string().optional(),
      priority: z.string().optional(),
      severity: z.string().optional(),
      assigned_to: z.string().optional(),
      cc: z.array(z.string()).optional(),
      alias: z.string().optional(),
      blocks: z.array(z.number().int()).optional(),
      depends_on: z.array(z.number().int()).optional(),
      keywords: z.array(z.string()).optional(),
      custom_fields: customFieldsSchema.optional(),
    },
    async ({ custom_fields, ...args }) =>
      run(() => client.post("/bug", mergeCustomFields(custom_fields, args))),
  );

  server.tool(
    "update_bug",
    "Update an existing bug: change status, resolution, assignee, and other fields. Closing a bug is done here (e.g. status=RESOLVED, resolution=FIXED).",
    {
      id_or_alias: z.string().describe("Bug ID or alias to update"),
      status: z.string().optional(),
      resolution: z.string().optional(),
      dupe_of: z.number().int().optional().describe("Bug ID this is a duplicate of"),
      assigned_to: z.string().optional(),
      priority: z.string().optional(),
      severity: z.string().optional(),
      summary: z.string().optional(),
      product: z.string().optional(),
      component: z.string().optional(),
      version: z.string().optional(),
      comment: z
        .object({
          body: z.string(),
          is_private: z.boolean().optional(),
        })
        .optional()
        .describe("Comment to add along with the update"),
      keywords: z
        .object({
          add: z.array(z.string()).optional(),
          remove: z.array(z.string()).optional(),
          set: z.array(z.string()).optional(),
        })
        .optional(),
      cc: z
        .object({
          add: z.array(z.string()).optional(),
          remove: z.array(z.string()).optional(),
        })
        .optional(),
      custom_fields: customFieldsSchema.optional(),
    },
    async ({ id_or_alias, custom_fields, ...rest }) =>
      run(() =>
        client.put(
          `/bug/${encodeURIComponent(id_or_alias)}`,
          mergeCustomFields(custom_fields, rest),
        ),
      ),
  );

  server.tool(
    "get_bug_history",
    "Get the change history of a bug.",
    {
      id: z.string().describe("Bug ID or alias"),
      new_since: z.string().optional().describe("ISO 8601 datetime; only changes after this time"),
    },
    async ({ id, new_since }) =>
      run(() => client.get(`/bug/${encodeURIComponent(id)}/history`, { new_since })),
  );

  server.tool(
    "get_comments",
    "Get all comments on a bug.",
    {
      id_or_alias: z.string().describe("Bug ID or alias"),
      new_since: z.string().optional().describe("ISO 8601 datetime; only comments after this time"),
    },
    async ({ id_or_alias, new_since }) =>
      run(() => client.get(`/bug/${encodeURIComponent(id_or_alias)}/comment`, { new_since })),
  );

  server.tool(
    "add_comment",
    "Add a comment to a bug.",
    {
      id: z.string().describe("Bug ID or alias"),
      comment: z.string().describe("Comment text"),
      is_private: z.boolean().optional(),
    },
    async ({ id, comment, is_private }) =>
      run(() => client.post(`/bug/${encodeURIComponent(id)}/comment`, { comment, is_private })),
  );

  server.tool(
    "list_attachments",
    "List attachments on a bug (metadata only, without file data).",
    {
      bug_id: z.string().describe("Bug ID or alias"),
    },
    async ({ bug_id }) =>
      run(() =>
        client.get(`/bug/${encodeURIComponent(bug_id)}/attachment`, {
          exclude_fields: "data",
        }),
      ),
  );

  server.tool(
    "create_attachment",
    "Attach a file to a bug. Data must be base64-encoded.",
    {
      bug_id: z.string().describe("Bug ID or alias to attach to"),
      data: z.string().describe("Base64-encoded file content"),
      file_name: z.string(),
      summary: z.string().describe("Short description of the attachment"),
      content_type: z.string().describe("MIME type, e.g. text/plain"),
      comment: z.string().optional(),
      is_patch: z.boolean().optional(),
      is_private: z.boolean().optional(),
    },
    async ({ bug_id, ...rest }) =>
      run(() => client.post(`/bug/${encodeURIComponent(bug_id)}/attachment`, rest)),
  );

  server.tool(
    "list_products",
    "List products (projects). type selects which set: accessible (default), enterable (can file bugs), or selectable (can search).",
    {
      type: z.enum(["accessible", "enterable", "selectable"]).default("accessible"),
    },
    async ({ type }) =>
      run(async () => {
        const { ids } = (await client.get(`/product_${type}`)) as { ids: number[] };
        if (ids.length === 0) return { products: [] };
        return client.get("/product", {
          ids,
          include_fields: "id,name,description,is_active",
        });
      }),
  );

  server.tool(
    "get_product",
    "Get a product (project) by ID or name, including its components, versions, and milestones.",
    {
      id_or_name: z.string().describe("Product ID or name"),
    },
    async ({ id_or_name }) => run(() => client.get(`/product/${encodeURIComponent(id_or_name)}`)),
  );

  server.tool(
    "create_product",
    "Create a new product (project). Requires admin privileges.",
    {
      name: z.string(),
      description: z.string(),
      version: z.string().optional().describe("Default version (default: 'unspecified')"),
      has_unconfirmed: z.boolean().optional(),
      classification: z.string().optional(),
      default_milestone: z.string().optional(),
      is_open: z.boolean().optional(),
      create_series: z.boolean().optional(),
    },
    async (args) => run(() => client.post("/product", args)),
  );

  server.tool(
    "update_product",
    "Update an existing product (project). Requires admin privileges.",
    {
      id_or_name: z.string().describe("Product ID or name to update"),
      name: z.string().optional().describe("New product name"),
      description: z.string().optional(),
      default_milestone: z.string().optional(),
      has_unconfirmed: z.boolean().optional(),
      is_open: z.boolean().optional(),
    },
    async ({ id_or_name, ...rest }) =>
      run(() => client.put(`/product/${encodeURIComponent(id_or_name)}`, rest)),
  );

  server.tool(
    "create_component",
    "Create a new component within a product. Requires admin privileges.",
    {
      product: z.string().describe("Product name the component belongs to"),
      name: z.string(),
      description: z.string(),
      default_assignee: z.string().describe("Login of the default assignee"),
      default_cc: z.array(z.string()).optional(),
      default_qa_contact: z.string().optional(),
      is_open: z.boolean().optional(),
    },
    async (args) => run(() => client.post("/component", args)),
  );

  server.tool(
    "get_field_values",
    "Get the legal (valid) values for a bug field, e.g. status, priority, severity, resolution.",
    {
      field: z.string().describe("Field name, e.g. bug_status, priority, severity, resolution"),
    },
    async ({ field }) =>
      run(() => client.get(`/field/bug/${encodeURIComponent(field)}/values`)),
  );
}
