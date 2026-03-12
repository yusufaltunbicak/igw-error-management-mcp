import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IgwApiClient, truncateResult, handleApiError } from "../services/api.js";

export function registerLookupTools(
  server: McpServer,
  api: IgwApiClient
): void {
  server.tool(
    "igw_products_search",
    "Search IGW products by name. Returns product list with IDs for use in error filters.",
    {
      query: z.string().optional().describe("Search query for product name"),
      page: z.number().optional().describe("Page number"),
      pageSize: z.number().optional().describe("Page size"),
    },
    async ({ query, page, pageSize }) => {
      try {
        const result = await api.searchProducts(query, page, pageSize);
        return { content: [{ type: "text", text: truncateResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "igw_insurance_companies",
    "List insurance companies available to the current agent. Returns company IDs for use in error filters.",
    {},
    async () => {
      try {
        const result = await api.getMyInsuranceCompanies();
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
