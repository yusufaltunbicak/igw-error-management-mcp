import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import {
  ManagementConsoleClient,
  serializeManagementConsoleError,
} from "../services/management-console.js";

type JsonObject = Record<string, unknown>;

function serializeSearchResult(
  meta: JsonObject,
  outgoingLogs: JsonObject[],
  incomingLogs: JsonObject[]
): string {
  let outgoing = outgoingLogs;
  let incoming = incomingLogs;
  for (;;) {
    const candidate = {
      ...meta,
      returned: {
        outgoing: outgoing.length,
        incoming: incoming.length,
        total: outgoing.length + incoming.length,
      },
      ...(outgoing.length < outgoingLogs.length || incoming.length < incomingLogs.length
        ? {
            returnedTruncatedForSize: true,
            droppedForSize:
              outgoingLogs.length + incomingLogs.length - outgoing.length - incoming.length,
          }
        : {}),
      outgoingLogs: outgoing,
      incomingLogs: incoming,
    };
    const json = JSON.stringify(candidate, null, 2);
    if (json.length <= CHARACTER_LIMIT || outgoing.length + incoming.length === 0) {
      return json;
    }
    if (outgoing.length >= incoming.length && outgoing.length > 0) {
      outgoing = outgoing.slice(0, -1);
    } else {
      incoming = incoming.slice(0, -1);
    }
  }
}

function serializeIncomingList(meta: JsonObject, rows: unknown[]): string {
  let included = rows;
  for (;;) {
    const candidate = {
      ...meta,
      returned: included.length,
      ...(included.length < rows.length
        ? {
            returnedTruncatedForSize: true,
            droppedForSize: rows.length - included.length,
          }
        : {}),
      incomingLogs: included,
    };
    const json = JSON.stringify(candidate, null, 2);
    if (json.length <= CHARACTER_LIMIT || included.length === 0) return json;
    included = included.slice(0, -1);
  }
}

export function serializeManagementConsolePayloadResult(
  meta: JsonObject,
  result: {
    flow: string;
    format: string;
    totalChars: number;
    returnedChars: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
    truncated: boolean;
    payload: string;
  }
): string {
  const build = (payload: string): string => {
    const end = result.offset + payload.length;
    const hasMore = end < result.totalChars;
    return JSON.stringify({
      ...meta,
      ...result,
      payload,
      returnedChars: payload.length,
      nextOffset: hasMore ? end : null,
      hasMore,
      truncated: result.offset > 0 || hasMore,
    });
  };

  let low = 0;
  let high = result.payload.length;
  let best = build("");
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(result.payload.slice(0, middle));
    if (candidate.length <= CHARACTER_LIMIT) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function registerManagementConsoleTools(
  server: McpServer,
  portal: ManagementConsoleClient
): void {
  server.tool(
    "igw_management_console_search",
    "Search read-only IGW Management Console request flows by one exact identifier. Outgoing means IGW/insurance-company traffic; incoming means client/IGW traffic. The portal spelling referanceNo is intentionally preserved. Pagination is applied independently to each selected direction.",
    {
      searchType: z.enum([
        "requestId",
        "proposalId",
        "referanceNo",
        "exceptionLogId",
        "policyId",
        "jobId",
        "insuranceCompanyProposalId",
        "platformProposalId",
      ]),
      value: z.string().trim().min(1).max(500).describe("Identifier value; kept as a string"),
      includeInternalLogs: z
        .boolean()
        .default(false)
        .describe("Use logLevel 2 to include internal logs; default false uses logLevel 0"),
      direction: z
        .enum(["all", "outgoing", "incoming"])
        .default("all")
        .describe("Return both directions or only one"),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    },
    async (args) => {
      try {
        const parsed = await portal.search(args);
        const start = (args.page - 1) * args.pageSize;
        const outgoing =
          args.direction === "incoming"
            ? []
            : parsed.outgoingLogs.slice(start, start + args.pageSize);
        const incoming =
          args.direction === "outgoing"
            ? []
            : parsed.incomingLogs.slice(start, start + args.pageSize);
        const text = serializeSearchResult(
          {
            searchType: args.searchType,
            value: args.value,
            includeInternalLogs: args.includeInternalLogs,
            logLevel: args.includeInternalLogs ? 2 : 0,
            direction: args.direction,
            page: args.page,
            pageSize: args.pageSize,
            pagination: "page/pageSize are applied independently to each selected direction",
            agents: parsed.agents,
            matched: {
              outgoing: parsed.outgoingLogs.length,
              incoming: parsed.incomingLogs.length,
              total: parsed.outgoingLogs.length + parsed.incomingLogs.length,
            },
            flows: {
              outgoing: "IGW <-> insurer",
              incoming: "client <-> IGW",
            },
            payloadLookupHints: {
              outgoing: {
                sent: {
                  tool: "igw_management_console_payload",
                  logType: "Outgoing",
                  payloadSide: "sent",
                  flow: "IGW -> insurer request",
                },
                received: {
                  tool: "igw_management_console_payload",
                  logType: "Outgoing",
                  payloadSide: "received",
                  flow: "insurer -> IGW response",
                },
              },
              incoming: {
                received: {
                  tool: "igw_management_console_payload",
                  logType: "Incoming",
                  payloadSide: "received",
                  flow: "client -> IGW request",
                },
                sent: {
                  tool: "igw_management_console_payload",
                  logType: "Incoming",
                  payloadSide: "sent",
                  flow: "IGW -> client response",
                },
              },
              instruction: "Use a returned logId as the payload tool's logId string.",
            },
          },
          outgoing.map((log) => ({ ...log })),
          incoming.map((log) => ({ ...log }))
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: serializeManagementConsoleError(error) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "igw_management_console_payload",
    "Read one raw Management Console payload without parsing or coercing its schema. Outgoing sent/received are the insurer request/response; Incoming received/sent are the client request/response. Large payloads are returned in offset chunks.",
    {
      logId: z.string().trim().min(1).max(200).describe("Log ID string returned by a search/list tool"),
      logType: z.enum(["Outgoing", "Incoming"]),
      payloadSide: z.enum(["sent", "received"]),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(1).max(24_000).default(20_000),
    },
    async (args) => {
      try {
        const result = await portal.getPayload(args);
        const text = serializeManagementConsolePayloadResult(
          {
            logId: args.logId,
            logType: args.logType,
            payloadSide: args.payloadSide,
          },
          result
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: serializeManagementConsoleError(error) }],
          isError: true,
        };
      }
    }
  );

  const optionalId = z
    .union([z.string().trim().min(1).max(200), z.number().int().nonnegative()])
    .optional();
  server.tool(
    "igw_management_console_logs_list",
    "List read-only incoming Management Console logs directly from the server-side DataTables endpoint. Dates are ISO strings, the range may not exceed 7 calendar days, and rows are projected onto the portal's eight documented columns.",
    {
      beginDate: z.string().max(64).describe("ISO begin date or datetime, e.g. 2026-07-30"),
      endDate: z.string().max(64).describe("ISO end date or datetime; maximum range 7 days"),
      agentId: optionalId.describe("Optional exact agent ID"),
      serviceOperationId: optionalId.describe("Optional exact service operation ID"),
      outSourceProcessId: optionalId.describe("Optional exact outsource process ID"),
      insuranceCompanyId: optionalId.describe("Optional exact insurance company ID"),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    },
    async (args) => {
      try {
        const result = await portal.listIncomingLogs(args);
        const text = serializeIncomingList(
          {
            page: args.page,
            pageSize: args.pageSize,
            filters: {
              beginDate: args.beginDate,
              endDate: args.endDate,
              ...(args.agentId != null ? { agentId: String(args.agentId) } : {}),
              ...(args.serviceOperationId != null
                ? { serviceOperationId: String(args.serviceOperationId) }
                : {}),
              ...(args.outSourceProcessId != null
                ? { outSourceProcessId: String(args.outSourceProcessId) }
                : {}),
              ...(args.insuranceCompanyId != null
                ? { insuranceCompanyId: String(args.insuranceCompanyId) }
                : {}),
            },
            draw: result.draw,
            recordsTotal: result.recordsTotal,
            recordsFiltered: result.recordsFiltered,
          },
          result.data
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: serializeManagementConsoleError(error) }],
          isError: true,
        };
      }
    }
  );
}
