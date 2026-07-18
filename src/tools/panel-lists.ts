import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodTypeAny } from "zod";
import { PanelClient } from "../services/panel.js";
import { handleApiError } from "../services/api.js";
import { CHARACTER_LIMIT } from "../constants.js";

type Row = Record<string, unknown>;

function tr(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase("tr-TR");
}

/**
 * Serialize a list result as valid JSON that always fits the character
 * limit. If the projected rows are too large (e.g. nested product/service
 * arrays), drop rows from the end until it fits and flag the truncation —
 * unlike the generic truncateResult, this never emits broken JSON.
 */
function serializeFitting(
  meta: Record<string, unknown>,
  resultKey: string,
  rows: Row[]
): string {
  let out = rows;
  for (;;) {
    const candidate = {
      ...meta,
      returned: out.length,
      ...(out.length < rows.length
        ? { returnedTruncatedForSize: true, droppedForSize: rows.length - out.length }
        : {}),
      [resultKey]: out,
    };
    const json = JSON.stringify(candidate, null, 2);
    if (json.length <= CHARACTER_LIMIT || out.length === 0) return json;
    const drop = Math.max(1, Math.floor(out.length * 0.15));
    out = out.slice(0, out.length - drop);
  }
}

/** A single filter: a zod schema for the arg + a predicate over a row. */
export interface FilterDef {
  key: string;
  schema: ZodTypeAny;
  apply: (row: Row, value: unknown) => boolean;
}

/** Substring match on a string field (Turkish-case-insensitive). */
export function strContains(key: string, field: string, describe: string): FilterDef {
  return {
    key,
    schema: z.string().optional().describe(describe),
    apply: (row, v) => tr(row[field]).includes(tr(v)),
  };
}

/** Substring match across any of several string fields (OR). */
export function strContainsAny(
  key: string,
  fields: string[],
  describe: string
): FilterDef {
  return {
    key,
    schema: z.string().optional().describe(describe),
    apply: (row, v) => fields.some((f) => tr(row[f]).includes(tr(v))),
  };
}

/** Exact numeric match on a field. */
export function numEquals(key: string, field: string, describe: string): FilterDef {
  return {
    key,
    schema: z.number().optional().describe(describe),
    apply: (row, v) => Number(row[field]) === Number(v),
  };
}

/** Exact boolean match on a field. */
export function boolEquals(key: string, field: string, describe: string): FilterDef {
  return {
    key,
    schema: z.boolean().optional().describe(describe),
    apply: (row, v) => Boolean(row[field]) === Boolean(v),
  };
}

/**
 * One arg that matches either an exact numeric id (when the value is all
 * digits) or a substring of a name field otherwise. Mirrors how the panel
 * dropdowns accept "7" or "Anadolu".
 */
export function idOrName(
  key: string,
  idField: string,
  nameField: string,
  describe: string
): FilterDef {
  return {
    key,
    schema: z.string().optional().describe(describe),
    apply: (row, v) => {
      const s = String(v).trim();
      if (/^\d+$/.test(s)) return Number(row[idField]) === Number(s);
      return tr(row[nameField]).includes(tr(s));
    },
  };
}

interface CachedListConfig {
  tool: string;
  description: string;
  endpoint: string;
  resultKey: string;
  filters: FilterDef[];
  project?: (row: Row) => Row;
}

/**
 * Register a read-only list tool backed by a full-fetch panel endpoint:
 * pull the whole list once (cached ~10 min), filter locally (all filters
 * AND together, Turkish-case-insensitive substrings), paginate the output.
 */
export function registerCachedListTool(
  server: McpServer,
  panel: PanelClient,
  cfg: CachedListConfig
): void {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of cfg.filters) shape[f.key] = f.schema;
  shape.refresh = z
    .boolean()
    .optional()
    .describe("Bypass the 10-minute cache and refetch from the panel");
  shape.page = z.number().optional().describe("Page number over the filtered result (default 1)");
  shape.pageSize = z.number().optional().describe("Page size (default 50)");

  server.tool(cfg.tool, cfg.description, shape, async (args: Record<string, unknown>) => {
    try {
      const all = await panel.fetchAll<Row>(cfg.endpoint, args.refresh === true);
      const filtered = all.filter((row) =>
        cfg.filters.every((f) => args[f.key] == null || f.apply(row, args[f.key]))
      );

      const page = typeof args.page === "number" && args.page > 0 ? args.page : 1;
      const pageSize =
        typeof args.pageSize === "number" && args.pageSize > 0 ? args.pageSize : 50;
      const start = (page - 1) * pageSize;
      const rows = filtered
        .slice(start, start + pageSize)
        .map((r) => (cfg.project ? cfg.project(r) : r));

      const text = serializeFitting(
        { total: all.length, matched: filtered.length, page, pageSize },
        cfg.resultKey,
        rows
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
        isError: true,
      };
    }
  });
}

interface PagedListConfig {
  tool: string;
  description: string;
  endpoint: string;
  resultKey: string;
  /** Filters applied to the fetched page only (not server-side). */
  filters: FilterDef[];
  project?: (row: Row) => Row;
}

/**
 * Register a read-only list tool backed by a server-side-paged panel
 * endpoint (for tables too large to pull in full). page/pageSize map to
 * the DataTables start/length; the endpoint returns them in its default
 * order. Any filters are applied to the fetched page ONLY — they narrow
 * what you already pulled, they do not search the whole table.
 */
export function registerPagedListTool(
  server: McpServer,
  panel: PanelClient,
  cfg: PagedListConfig
): void {
  const shape: Record<string, ZodTypeAny> = {};
  shape.page = z.number().optional().describe("Page number (default 1)");
  shape.pageSize = z
    .number()
    .optional()
    .describe("Rows per server-side page, 1-500 (default 50)");
  for (const f of cfg.filters) shape[f.key] = f.schema;

  server.tool(cfg.tool, cfg.description, shape, async (args: Record<string, unknown>) => {
    try {
      const page = typeof args.page === "number" && args.page > 0 ? args.page : 1;
      const rawSize =
        typeof args.pageSize === "number" && args.pageSize > 0 ? args.pageSize : 50;
      const pageSize = Math.min(rawSize, 500);
      const start = (page - 1) * pageSize;

      const { rows, total } = await panel.fetchPage<Row>(cfg.endpoint, start, pageSize);
      const filtered = rows.filter((row) =>
        cfg.filters.every((f) => args[f.key] == null || f.apply(row, args[f.key]))
      );
      const projected = filtered.map((r) => (cfg.project ? cfg.project(r) : r));

      const activeFilters = cfg.filters.some((f) => args[f.key] != null);
      const text = serializeFitting(
        {
          totalOnServer: total,
          page,
          pageSize,
          returnedFromServer: rows.length,
          matchedOnPage: projected.length,
          note: activeFilters
            ? "Filtreler yalnızca bu sayfada uygulandı; tüm tabloyu taramaz. Sayfa/pageSize ile gezin."
            : "Server-side sayfalama; endpoint'in varsayılan sırası.",
        },
        cfg.resultKey,
        projected
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
        isError: true,
      };
    }
  });
}
