import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IgwApiClient, truncateResult, handleApiError } from "../services/api.js";

export function registerErrorTools(server: McpServer, api: IgwApiClient): void {
  server.tool(
    "igw_errors_list",
    "List IGW errors with filters (date range, branch, product, company, status flags). Returns paginated error list.",
    {
      BeginDate: z
        .string()
        .optional()
        .describe("Start date filter (ISO 8601, e.g. 2024-01-01)"),
      EndDate: z
        .string()
        .optional()
        .describe("End date filter (ISO 8601)"),
      BranchId: z.number().optional().describe("Branch ID filter"),
      ProductId: z.number().optional().describe("Product ID filter"),
      InsuranceCompanyId: z
        .number()
        .optional()
        .describe("Insurance company ID filter"),
      ServiceOperationId: z
        .number()
        .optional()
        .describe("Service operation ID filter"),
      NotAnalysed: z.boolean().optional().describe("Filter: not analysed errors"),
      Solved: z.boolean().optional().describe("Filter: solved errors"),
      InProgress: z.boolean().optional().describe("Filter: in-progress errors"),
      NothingToDo: z.boolean().optional().describe("Filter: nothing-to-do errors"),
      UserMistake: z.boolean().optional().describe("Filter: user mistake errors"),
      ConnectionError: z
        .boolean()
        .optional()
        .describe("Filter: connection errors"),
      OperationTimeout: z
        .boolean()
        .optional()
        .describe("Filter: operation timeout errors"),
      PageNumber: z.number().optional().describe("Page number (default 1)"),
      PageSize: z.number().optional().describe("Page size (default 20)"),
    },
    async (params) => {
      try {
        const result = await api.listErrors(params);
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
    "igw_errors_operations",
    "Get error operations/service operations list with filters. Useful for understanding which operations produce errors.",
    {
      BeginDate: z.string().optional().describe("Start date (ISO 8601)"),
      EndDate: z.string().optional().describe("End date (ISO 8601)"),
      BranchId: z.number().optional().describe("Branch ID"),
      ProductId: z.number().optional().describe("Product ID"),
      InsuranceCompanyId: z.number().optional().describe("Insurance company ID"),
      ServiceOperationId: z.number().optional().describe("Service operation ID"),
      NotAnalysed: z.boolean().optional(),
      Solved: z.boolean().optional(),
      InProgress: z.boolean().optional(),
      NothingToDo: z.boolean().optional(),
      UserMistake: z.boolean().optional(),
      ConnectionError: z.boolean().optional(),
      OperationTimeout: z.boolean().optional(),
    },
    async (params) => {
      try {
        const result = await api.getErrorOperations(params);
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
    "igw_errors_logs",
    "Get error logs with filters. Returns detailed log entries for errors.",
    {
      BeginDate: z.string().optional().describe("Start date (ISO 8601)"),
      EndDate: z.string().optional().describe("End date (ISO 8601)"),
      BranchId: z.number().optional().describe("Branch ID"),
      ProductId: z.number().optional().describe("Product ID"),
      InsuranceCompanyId: z.number().optional().describe("Insurance company ID"),
      ServiceOperationId: z.number().optional().describe("Service operation ID"),
      NotAnalysed: z.boolean().optional(),
      Solved: z.boolean().optional(),
      InProgress: z.boolean().optional(),
      NothingToDo: z.boolean().optional(),
      UserMistake: z.boolean().optional(),
      ConnectionError: z.boolean().optional(),
      OperationTimeout: z.boolean().optional(),
      PageNumber: z.number().optional().describe("Page number"),
      PageSize: z.number().optional().describe("Page size"),
    },
    async (params) => {
      try {
        const result = await api.getErrorLogs(params);
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
    "igw_errors_log_detail",
    "Get detailed log for a specific error by ID. Shows full request/response data.",
    {
      id: z.number().describe("Error log ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.getErrorLogDetail(id);
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
    "igw_errors_analyze",
    "Analyze a specific error by ID. Returns analysis details including possible causes and suggestions.",
    {
      id: z.number().describe("Error ID to analyze"),
    },
    async ({ id }) => {
      try {
        const result = await api.analyzeError(id);
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
