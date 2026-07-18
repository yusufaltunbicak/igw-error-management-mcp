import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PanelClient } from "../services/panel.js";
import { truncateResult, handleApiError } from "../services/api.js";
import { PanelKey } from "../types.js";

function tr(value: string): string {
  return value.toLocaleLowerCase("tr-TR");
}

export function registerKeyTools(server: McpServer, panel: PanelClient): void {
  server.tool(
    "igw_keys_list",
    `List IGW request/response keys from the GatewayProUI admin panel with full details: key Id, key name, value type (string/int/decimal/datetime/double/json), whether it is parameterized, its parameter (ParameterId + resolved ParameterName), whether it is dependent (Depent), and active status.

Keys are the field definitions used to build insurance company request/response mappings. A parameterized key draws its value from a parameter list (e.g. key "Sigortalı Türü" → parameter 6); parameter names are resolved from the panel's parameter catalog since the key list itself leaves them null.

All filters combine with AND. Filtering is local over the full key list, so any substring works regardless of Turkish casing.`,
    {
      query: z.string().optional().describe("Substring match on key name (e.g. 'T.C. Kimlik', 'Plaka')"),
      keyId: z.number().optional().describe("Exact key Id lookup"),
      keyValueType: z.string().optional().describe("Value type substring/exact: 'string', 'int', 'decimal', 'datetime', 'double', 'json'"),
      parameterized: z.boolean().optional().describe("true = keys backed by a parameter list only, false = non-parameterized only"),
      parameterId: z.number().optional().describe("Exact parameter Id the key is bound to"),
      parameterName: z.string().optional().describe("Substring match on the resolved parameter name (e.g. 'İller', 'Marka')"),
      dependent: z.boolean().optional().describe("Filter by the key's Depent flag (value depends on another key)"),
      isActive: z.boolean().optional().describe("true = active (Status) keys only, false = passive only"),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache and refetch from the panel"),
      page: z.number().optional().describe("Page number over the filtered result (default 1)"),
      pageSize: z.number().optional().describe("Page size (default 50)"),
    },
    async (args) => {
      try {
        const [keys, parameters] = await Promise.all([
          panel.getAllKeys(args.refresh === true),
          panel.getAllParameters(args.refresh === true),
        ]);
        const paramNameById = new Map(
          parameters.map((p) => [p.ParameterId, p.ParameterName])
        );

        const resolveParamName = (k: PanelKey): string | null =>
          k.ParameterName ??
          (k.ParameterId != null ? paramNameById.get(k.ParameterId) ?? null : null);

        const filtered = keys.filter((k: PanelKey) => {
          if (args.keyId != null && k.Id !== args.keyId) return false;
          if (args.query && !tr(k.KeyName).includes(tr(args.query))) return false;
          if (args.keyValueType && !tr(k.KeyValueType).includes(tr(args.keyValueType)))
            return false;
          if (args.parameterized != null && k.Parameterized !== args.parameterized)
            return false;
          if (args.parameterId != null && k.ParameterId !== args.parameterId)
            return false;
          if (args.parameterName) {
            const name = resolveParamName(k);
            if (!name || !tr(name).includes(tr(args.parameterName))) return false;
          }
          if (args.dependent != null && k.Depent !== args.dependent) return false;
          if (args.isActive != null && k.Status !== args.isActive) return false;
          return true;
        });

        const page = args.page && args.page > 0 ? args.page : 1;
        const pageSize = args.pageSize && args.pageSize > 0 ? args.pageSize : 50;
        const start = (page - 1) * pageSize;
        const rows = filtered.slice(start, start + pageSize).map((k) => ({
          KeyId: k.Id,
          KeyName: k.KeyName,
          KeyValueType: k.KeyValueType,
          Parameterized: k.Parameterized,
          ParameterId: k.ParameterId,
          ParameterName: resolveParamName(k),
          Dependent: k.Depent,
          IsActive: k.Status,
        }));

        const result = {
          totalKeys: keys.length,
          matched: filtered.length,
          page,
          pageSize,
          returned: rows.length,
          keys: rows,
        };
        return { content: [{ type: "text", text: truncateResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );
}
