import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IgwApiClient, truncateResult, handleApiError } from "../services/api.js";

export function registerErrorActionTools(
  server: McpServer,
  api: IgwApiClient
): void {
  server.tool(
    "igw_errors_pin",
    "Pin or unpin an error for tracking. Pinned errors are highlighted in the error list.",
    {
      errorId: z.number().describe("Error ID to pin/unpin"),
      isPinned: z.boolean().describe("true to pin, false to unpin"),
    },
    async (params) => {
      try {
        const result = await api.pinError(params);
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
    "igw_errors_send_report",
    "Send an error report to the relevant team with a description.",
    {
      errorId: z.number().describe("Error ID to report"),
      description: z.string().describe("Description/notes for the error report"),
    },
    async (params) => {
      try {
        const result = await api.sendErrorReport(params);
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
    "igw_errors_send_bug_report",
    "Send a bug report by reference number to the InsurGateway team.",
    {
      referenceNo: z
        .string()
        .describe("Error reference number (e.g. IGW-12345)"),
    },
    async ({ referenceNo }) => {
      try {
        const result = await api.sendBugReport(referenceNo);
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
