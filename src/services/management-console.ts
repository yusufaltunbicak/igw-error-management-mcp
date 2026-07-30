import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import {
  ManagementConsoleConfig,
  ManagementConsoleIncomingLog,
  ManagementConsoleIncomingListLog,
  ManagementConsoleIncomingLogsParams,
  ManagementConsoleIncomingLogsResponse,
  ManagementConsoleLogType,
  ManagementConsoleOutgoingLog,
  ManagementConsoleParsedSearch,
  ManagementConsolePayloadFormat,
  ManagementConsolePayloadParams,
  ManagementConsolePayloadSide,
  ManagementConsoleSearchParams,
  ManagementConsoleSearchType,
} from "../types.js";
import {
  MANAGEMENT_CONSOLE_DEFAULT_PAYLOAD_CHARS,
  MANAGEMENT_CONSOLE_MAX_PAYLOAD_CHARS,
  MANAGEMENT_CONSOLE_MAX_RESPONSE_BYTES,
  MANAGEMENT_CONSOLE_TIMEOUT_MS,
} from "../constants.js";

export const MANAGEMENT_CONSOLE_SEARCH_ENDPOINTS = {
  requestId: "/ManagementConsole/GetLogListByRequestId",
  proposalId: "/ManagementConsole/GetLogListByProposalId",
  referanceNo: "/ManagementConsole/GetLogListByReferanceNo",
  exceptionLogId: "/ManagementConsole/GetLogListByExceptionId",
  policyId: "/ManagementConsole/GetLogListByPolicyId",
  jobId: "/ManagementConsole/GetLogListByJobId",
  insuranceCompanyProposalId:
    "/ManagementConsole/GetLogListByInsuranceCompanyProposalId",
  platformProposalId: "/ManagementConsole/GetLogListByPlatformProposalId",
} as const satisfies Record<ManagementConsoleSearchType, string>;

const INCOMING_LOG_COLUMNS = [
  "Id",
  "ReferanceNo",
  "AgentId",
  "Action",
  "RequestDate",
  "ElapsedTime",
  "MachineName",
  "IpAddress",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export class ManagementConsoleClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ManagementConsoleClientError";
  }
}

export function getManagementConsoleSearchEndpoint(
  searchType: ManagementConsoleSearchType
): string {
  return MANAGEMENT_CONSOLE_SEARCH_ENDPOINTS[searchType];
}

export function buildManagementConsoleSearchRequest(
  searchType: ManagementConsoleSearchType,
  value: string,
  includeInternalLogs = false
): { path: string; query: string; logLevel: 0 | 2 } {
  if (!value.trim() || value.length > 500) {
    throw new ManagementConsoleClientError(
      "invalid_input",
      "Management Console search value must contain 1-500 characters."
    );
  }
  const logLevel = includeInternalLogs ? 2 : 0;
  const query = new URLSearchParams({
    logLevel: String(logLevel),
    id: value,
  }).toString();
  return { path: getManagementConsoleSearchEndpoint(searchType), query, logLevel };
}

/** Decode one HTML-entity layer without executing browser or script content. */
export function decodeManagementConsoleHtml(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith("#x")) {
        const point = Number.parseInt(normalized.slice(2), 16);
        return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      if (normalized.startsWith("#")) {
        const point = Number.parseInt(normalized.slice(1), 10);
        return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      const named: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
        nbsp: "\u00a0",
      };
      return named[normalized] ?? match;
    }
  );
}

function extractAssignedString(html: string, property: string): string | null {
  const marker = new RegExp(
    `managementConsole\\.${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`,
    "i"
  ).exec(html);
  if (!marker) return null;

  const start = marker.index + marker[0].length;
  const delimiter = html[start];
  if (delimiter !== "`" && delimiter !== '"' && delimiter !== "'") {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console log data used an unsupported script format."
    );
  }

  for (let index = start + 1; index < html.length; index += 1) {
    if (html[index] !== delimiter) continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor > start && html[cursor] === "\\"; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      const raw = html.slice(start + 1, index);
      return delimiter === "`" ? raw.replace(/\\`/g, "`") : raw;
    }
  }

  throw new ManagementConsoleClientError(
    "malformed_response",
    "Management Console log data was incomplete."
  );
}

function parseAssignedRows(html: string, property: string): unknown[][] {
  const assigned = extractAssignedString(html, property);
  if (assigned === null || !assigned.trim()) return [];

  let parsed: unknown;
  try {
    // Script JSON syntax is already valid JSON. Decode entities only after
    // parsing individual string cells so a value such as &quot; cannot create
    // unescaped quote characters in the JSON document itself.
    parsed = JSON.parse(assigned);
  } catch {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned malformed log data."
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(Array.isArray)) {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned an unexpected log data shape."
    );
  }
  return parsed as unknown[][];
}

function textCell(row: unknown[], index: number): string {
  const value = row[index];
  return value == null ? "" : decodeManagementConsoleHtml(String(value));
}

function parseOutgoingRow(row: unknown[]): ManagementConsoleOutgoingLog {
  return {
    logId: textCell(row, 0),
    referenceNo: textCell(row, 1),
    proposalId: textCell(row, 2),
    product: textCell(row, 3),
    action: textCell(row, 4),
    requestDate: textCell(row, 5),
    elapsedMs: textCell(row, 6),
  };
}

function parseIncomingRow(row: unknown[]): ManagementConsoleIncomingLog {
  return {
    logId: textCell(row, 0),
    referenceNo: textCell(row, 1),
    action: textCell(row, 2),
    requestDate: textCell(row, 3),
    elapsedMs: textCell(row, 4),
    machineName: textCell(row, 5),
  };
}

export function parseManagementConsoleSearchHtml(
  html: string
): ManagementConsoleParsedSearch {
  const agents: ManagementConsoleParsedSearch["agents"] = [];
  const seenAgents = new Set<string>();
  const headingPattern = /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi;
  for (const match of html.matchAll(headingPattern)) {
    const heading = decodeManagementConsoleHtml(
      match[1].replace(/<[^>]+>/g, " ")
    ).replace(/\s+/g, " ").trim();
    const agentMatch = /^Acente\s*:\s*([^\s-]+)\s*-\s*(.+)$/i.exec(heading);
    if (!agentMatch) continue;
    const agent = { id: agentMatch[1].trim(), name: agentMatch[2].trim() };
    const key = `${agent.id}\u0000${agent.name}`;
    if (!seenAgents.has(key)) {
      agents.push(agent);
      seenAgents.add(key);
    }
  }

  return {
    agents,
    outgoingLogs: parseAssignedRows(html, "outgoingLogs").map(parseOutgoingRow),
    incomingLogs: parseAssignedRows(html, "incomingLogs").map(parseIncomingRow),
  };
}

export function getManagementConsolePayloadRequest(
  logId: string,
  logType: ManagementConsoleLogType,
  payloadSide: ManagementConsolePayloadSide
): { path: string; flow: string } {
  if (!logId.trim() || logId.length > 200) {
    throw new ManagementConsoleClientError(
      "invalid_input",
      "Management Console logId must contain 1-200 characters."
    );
  }

  const key = `${logType}:${payloadSide}` as const;
  const mapping: Record<string, { endpoint: string; flow: string }> = {
    "Outgoing:sent": {
      endpoint: "/ManagementConsole/GetSentOutgoingPayload",
      flow: "IGW -> insurer request",
    },
    "Outgoing:received": {
      endpoint: "/ManagementConsole/GetReceivedOutgoingPayload",
      flow: "insurer -> IGW response",
    },
    "Incoming:received": {
      endpoint: "/ManagementConsole/GetReceivedIncomingPayload",
      flow: "client -> IGW request",
    },
    "Incoming:sent": {
      endpoint: "/ManagementConsole/GetSentIncomingPayload",
      flow: "IGW -> client response",
    },
  };
  const selected = mapping[key];
  if (!selected) {
    throw new ManagementConsoleClientError(
      "invalid_input",
      "Unsupported Management Console payload direction."
    );
  }
  return {
    path: `${selected.endpoint}/${encodeURIComponent(logId)}`,
    flow: selected.flow,
  };
}

export function detectManagementConsolePayloadFormat(
  payload: string
): ManagementConsolePayloadFormat {
  const trimmed = payload.trim();
  if (trimmed) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Preserve and classify the raw payload; never coerce its schema.
    }
    if (/^(?:<\?xml[\s\S]*?\?>\s*)?<[^>]+>/i.test(trimmed)) return "xml";
  }
  return "text";
}

export function chunkManagementConsolePayload(
  payload: string,
  offset = 0,
  maxChars = MANAGEMENT_CONSOLE_DEFAULT_PAYLOAD_CHARS
): {
  format: ManagementConsolePayloadFormat;
  totalChars: number;
  returnedChars: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
  truncated: boolean;
  payload: string;
} {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ManagementConsoleClientError(
      "invalid_input",
      "Payload offset must be a non-negative integer."
    );
  }
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new ManagementConsoleClientError(
      "invalid_input",
      "Payload maxChars must be a positive integer."
    );
  }
  const safeMaxChars = Math.min(maxChars, MANAGEMENT_CONSOLE_MAX_PAYLOAD_CHARS);
  const start = Math.min(offset, payload.length);
  const end = Math.min(start + safeMaxChars, payload.length);
  const slice = payload.slice(start, end);
  return {
    format: detectManagementConsolePayloadFormat(payload),
    totalChars: payload.length,
    returnedChars: slice.length,
    offset: start,
    nextOffset: end < payload.length ? end : null,
    hasMore: end < payload.length,
    truncated: start > 0 || end < payload.length,
    payload: slice,
  };
}

function parseIsoDate(value: string): { epoch: number; display: string } {
  if (value.length > 64) {
    throw new ManagementConsoleClientError(
      "invalid_date",
      "Management Console dates must be valid ISO date strings."
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match || (value.length > 10 && Number.isNaN(Date.parse(value)))) {
    throw new ManagementConsoleClientError(
      "invalid_date",
      "Management Console dates must be valid ISO date strings."
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const check = new Date(epoch);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new ManagementConsoleClientError(
      "invalid_date",
      "Management Console dates must be valid ISO date strings."
    );
  }
  return { epoch, display: `${match[3]}.${match[2]}.${match[1]}` };
}

function optionalId(value: string | number | undefined): string {
  if (value == null) return "";
  const result = String(value).trim();
  if (!result || result.length > 200) {
    throw new ManagementConsoleClientError(
      "invalid_input",
      "Management Console filter IDs must contain 1-200 characters."
    );
  }
  return result;
}

export function buildManagementConsoleIncomingLogsRequest(
  params: ManagementConsoleIncomingLogsParams
): { path: string; query: string; body: string; dateRange: string } {
  const begin = parseIsoDate(params.beginDate);
  const end = parseIsoDate(params.endDate);
  if (end.epoch < begin.epoch || end.epoch - begin.epoch > 6 * DAY_MS) {
    throw new ManagementConsoleClientError(
      "invalid_date_range",
      "Management Console date range must be forward and no longer than 7 days."
    );
  }

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new ManagementConsoleClientError(
      "invalid_pagination",
      "Management Console page and pageSize must be positive integers."
    );
  }
  const safePageSize = Math.min(pageSize, 100);
  const dateRange = `${begin.display} - ${end.display}`;
  const query = new URLSearchParams({
    agentId: optionalId(params.agentId),
    serviceOperationId: optionalId(params.serviceOperationId),
    outSourceProcessId: optionalId(params.outSourceProcessId),
    insuranceCompanyId: optionalId(params.insuranceCompanyId),
  });
  const body = new URLSearchParams({
    draw: "1",
    start: String((page - 1) * safePageSize),
    length: String(safePageSize),
  });
  INCOMING_LOG_COLUMNS.forEach((column, index) => {
    body.set(`columns[${index}][data]`, column);
    body.set(`columns[${index}][name]`, column);
    body.set(`columns[${index}][searchable]`, "true");
    body.set(`columns[${index}][orderable]`, index === 1 || index === 7 ? "false" : "true");
    body.set(`columns[${index}][valueType]`, index === 4 ? "4" : "0");
    body.set(`columns[${index}][search][value]`, index === 4 ? dateRange : "");
    body.set(`columns[${index}][search][regex]`, "false");
  });
  body.set("order[0][column]", "0");
  body.set("order[0][dir]", "asc");
  body.set("search[value]", "");
  body.set("search[regex]", "false");

  return {
    path: "/ManagementConsole/GetIncomingLogs",
    query: query.toString(),
    body: body.toString(),
    dateRange,
  };
}

function incomingListCell(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value == null ? "" : decodeManagementConsoleHtml(String(value));
}

function projectIncomingListRow(row: unknown): ManagementConsoleIncomingListLog {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned an unexpected incoming-log row."
    );
  }
  const value = row as Record<string, unknown>;
  return {
    logId: incomingListCell(value, "Id"),
    referenceNo: incomingListCell(value, "ReferanceNo"),
    agentId: incomingListCell(value, "AgentId"),
    action: incomingListCell(value, "Action"),
    requestDate: incomingListCell(value, "RequestDate"),
    elapsedMs: incomingListCell(value, "ElapsedTime"),
    machineName: incomingListCell(value, "MachineName"),
    ipAddress: incomingListCell(value, "IpAddress"),
  };
}

export function parseManagementConsoleIncomingLogsResponse(
  raw: string
): ManagementConsoleIncomingLogsResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned malformed incoming-log data."
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned an unexpected incoming-log data shape."
    );
  }
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.data)) {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned an unexpected incoming-log data shape."
    );
  }
  const draw = Number(value.draw);
  const recordsTotal = Number(value.recordsTotal);
  const recordsFiltered = Number(value.recordsFiltered);
  if (![draw, recordsTotal, recordsFiltered].every(Number.isFinite)) {
    throw new ManagementConsoleClientError(
      "malformed_response",
      "Management Console returned incomplete incoming-log metadata."
    );
  }
  return {
    data: value.data.map(projectIncomingListRow),
    draw,
    recordsTotal,
    recordsFiltered,
  };
}

function extractAntiforgeryToken(html: string): string | null {
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*(["'])__RequestVerificationToken\1/i.exec(tag);
    if (!name) continue;
    const value = /\bvalue\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
    if (value) return decodeManagementConsoleHtml(value[2]);
  }
  return null;
}

export function isManagementConsoleLoginHtml(body: string): boolean {
  return (
    /__RequestVerificationToken/i.test(body) &&
    /EmailOrUserName/i.test(body) &&
    /(?:action\s*=\s*["'][^"']*\/Account\/Login|<form\b)/i.test(body)
  );
}

export function isManagementConsoleLoginRedirect(
  location: string | undefined,
  baseUrl: string
): boolean {
  if (!location) return false;
  try {
    const base = new URL(baseUrl);
    const redirect = new URL(location, base);
    return (
      redirect.origin === base.origin &&
      /^\/ManagementConsole(?:\/|$)/i.test(redirect.pathname)
    );
  } catch {
    return false;
  }
}

type PortalMethod = "GET" | "POST";

export class ManagementConsoleClient {
  private readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();
  private loginPromise: Promise<void> | null = null;
  private sessionVersion = 0;

  constructor(private readonly config: ManagementConsoleConfig) {
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      throw new ManagementConsoleClientError(
        "invalid_config",
        "Management Console base URL is invalid."
      );
    }
    const isLocalHttp =
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !isLocalHttp) ||
      parsed.username ||
      parsed.password
    ) {
      throw new ManagementConsoleClientError(
        "invalid_config",
        "Management Console base URL must use HTTPS without embedded credentials."
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  private collectCookies(response: AxiosResponse<string>): void {
    const setCookies = response.headers["set-cookie"];
    if (!setCookies) return;
    for (const raw of setCookies) {
      const pair = raw.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private async send(
    method: PortalMethod,
    path: string,
    options: {
      query?: URLSearchParams;
      data?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<AxiosResponse<string>> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new ManagementConsoleClientError(
        "invalid_request",
        "Management Console requests must use a static relative endpoint."
      );
    }
    const cookie = this.cookieHeader();
    const request: AxiosRequestConfig<string> = {
      baseURL: this.baseUrl,
      url: path,
      method,
      params: options.query,
      data: options.data,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
      timeout: MANAGEMENT_CONSOLE_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: MANAGEMENT_CONSOLE_MAX_RESPONSE_BYTES,
      maxBodyLength: 1024 * 1024,
      responseType: "text",
      transformResponse: [(data: string) => data],
      validateStatus: () => true,
    };
    try {
      const response = await axios.request<string>(request);
      this.collectCookies(response);
      return response;
    } catch {
      throw new ManagementConsoleClientError(
        "network_error",
        "Management Console request failed before a response was received."
      );
    }
  }

  private async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async doLogin(): Promise<void> {
    this.cookies.clear();
    const page = await this.send("GET", "/Account/Login", {
      headers: { Accept: "text/html" },
    });
    if (page.status !== 200) {
      throw new ManagementConsoleClientError(
        "login_failed",
        `Management Console login page failed (HTTP ${page.status}).`,
        page.status
      );
    }
    const token = extractAntiforgeryToken(page.data);
    if (!token) {
      throw new ManagementConsoleClientError(
        "login_failed",
        "Management Console login page did not contain an antiforgery token."
      );
    }
    const form = new URLSearchParams({
      EmailOrUserName: this.config.username,
      Password: this.config.password,
      RememberMe: "false",
      __RequestVerificationToken: token,
    });
    const response = await this.send("POST", "/Account/Login", {
      query: new URLSearchParams({ returnurl: "/ManagementConsole" }),
      data: form.toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (response.status !== 302) {
      throw new ManagementConsoleClientError(
        "login_failed",
        `Management Console login failed (HTTP ${response.status}); check portal credentials and access.`,
        response.status
      );
    }
    if (!isManagementConsoleLoginRedirect(response.headers.location, this.baseUrl)) {
      throw new ManagementConsoleClientError(
        "login_failed",
        "Management Console login did not redirect to /ManagementConsole.",
        response.status
      );
    }
    this.sessionVersion += 1;
  }

  private isExpired(response: AxiosResponse<string>): boolean {
    if (response.status === 401) return true;
    if (response.status === 200 && isManagementConsoleLoginHtml(response.data)) return true;
    if (response.status !== 302) return false;
    const location = String(response.headers.location ?? "");
    return !location || /\/Account\/Login/i.test(location);
  }

  private async authenticatedRequest(
    method: PortalMethod,
    path: string,
    options: {
      query?: URLSearchParams;
      data?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<string> {
    if (this.cookies.size === 0) await this.login();
    const attemptedVersion = this.sessionVersion;
    let response = await this.send(method, path, options);
    if (this.isExpired(response)) {
      if (attemptedVersion === this.sessionVersion) await this.login();
      response = await this.send(method, path, options);
    }
    if (this.isExpired(response)) {
      throw new ManagementConsoleClientError(
        "session_expired",
        "Management Console session expired again after one login retry.",
        response.status
      );
    }
    if (response.status !== 200) {
      throw new ManagementConsoleClientError(
        "request_failed",
        `Management Console request failed (HTTP ${response.status}).`,
        response.status
      );
    }
    return response.data;
  }

  async search(params: ManagementConsoleSearchParams): Promise<ManagementConsoleParsedSearch> {
    const request = buildManagementConsoleSearchRequest(
      params.searchType,
      params.value,
      params.includeInternalLogs
    );
    const html = await this.authenticatedRequest("GET", request.path, {
      query: new URLSearchParams(request.query),
      headers: { Accept: "text/html" },
    });
    return parseManagementConsoleSearchHtml(html);
  }

  async getPayload(params: ManagementConsolePayloadParams): Promise<{
    flow: string;
    format: ManagementConsolePayloadFormat;
    totalChars: number;
    returnedChars: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
    truncated: boolean;
    payload: string;
  }> {
    const request = getManagementConsolePayloadRequest(
      params.logId,
      params.logType,
      params.payloadSide
    );
    const raw = await this.authenticatedRequest("GET", request.path, {
      headers: { Accept: "text/plain" },
    });
    return {
      flow: request.flow,
      ...chunkManagementConsolePayload(raw, params.offset, params.maxChars),
    };
  }

  async listIncomingLogs(
    params: ManagementConsoleIncomingLogsParams
  ): Promise<ManagementConsoleIncomingLogsResponse> {
    const request = buildManagementConsoleIncomingLogsRequest(params);
    const raw = await this.authenticatedRequest("POST", request.path, {
      query: new URLSearchParams(request.query),
      data: request.body,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    return parseManagementConsoleIncomingLogsResponse(raw);
  }
}

export function serializeManagementConsoleError(error: unknown): string {
  const known = error instanceof ManagementConsoleClientError;
  return JSON.stringify(
    {
      error: {
        code: known ? error.code : "unexpected_error",
        message: known
          ? error.message
          : "An unexpected Management Console error occurred.",
        ...(known && error.status != null ? { status: error.status } : {}),
      },
    },
    null,
    2
  );
}
