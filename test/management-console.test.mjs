import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  ManagementConsoleClient,
  MANAGEMENT_CONSOLE_SEARCH_ENDPOINTS,
  buildManagementConsoleIncomingLogsRequest,
  buildManagementConsoleSearchRequest,
  chunkManagementConsolePayload,
  getManagementConsolePayloadRequest,
  isManagementConsoleLoginHtml,
  isManagementConsoleLoginRedirect,
  parseManagementConsoleIncomingLogsResponse,
  parseManagementConsoleSearchHtml,
} from "../dist/services/management-console.js";
import { serializeManagementConsolePayloadResult } from "../dist/tools/management-console.js";
import { CHARACTER_LIMIT } from "../dist/constants.js";

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function withLoopbackServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("maps every Management Console search type to its static endpoint", () => {
  assert.deepEqual(MANAGEMENT_CONSOLE_SEARCH_ENDPOINTS, {
    requestId: "/ManagementConsole/GetLogListByRequestId",
    proposalId: "/ManagementConsole/GetLogListByProposalId",
    referanceNo: "/ManagementConsole/GetLogListByReferanceNo",
    exceptionLogId: "/ManagementConsole/GetLogListByExceptionId",
    policyId: "/ManagementConsole/GetLogListByPolicyId",
    jobId: "/ManagementConsole/GetLogListByJobId",
    insuranceCompanyProposalId:
      "/ManagementConsole/GetLogListByInsuranceCompanyProposalId",
    platformProposalId: "/ManagementConsole/GetLogListByPlatformProposalId",
  });
});

test("builds encoded search queries with logLevel 0 or 2", () => {
  const normal = buildManagementConsoleSearchRequest(
    "referanceNo",
    "synthetic ref/42",
    false
  );
  const internal = buildManagementConsoleSearchRequest(
    "requestId",
    "synthetic-id",
    true
  );
  assert.equal(new URLSearchParams(normal.query).get("logLevel"), "0");
  assert.equal(new URLSearchParams(normal.query).get("id"), "synthetic ref/42");
  assert.equal(new URLSearchParams(internal.query).get("logLevel"), "2");
});

test("parses both script arrays, preserves string IDs and decodes cells after JSON parsing", () => {
  const html = `
    <h4>Acente: 0007 - Synthetic &amp; Agency</h4>
    <script>
      managementConsole.outgoingLogs = \`[["900719925474099312345","REF&amp;42","000123","Kasko &quot;Plus&quot;","Get &lt;Offer&gt;","30.07.2026","0012"]]\`;
      managementConsole.incomingLogs = \`[["000099","IN&amp;7","Create &quot;Proposal&quot;","30.07.2026","0008","machine&amp;one"]]\`;
    </script>`;
  const parsed = parseManagementConsoleSearchHtml(html);
  assert.deepEqual(parsed.agents, [
    { id: "0007", name: "Synthetic & Agency" },
  ]);
  assert.equal(parsed.outgoingLogs[0].logId, "900719925474099312345");
  assert.equal(parsed.outgoingLogs[0].proposalId, "000123");
  assert.equal(parsed.outgoingLogs[0].product, 'Kasko "Plus"');
  assert.equal(parsed.outgoingLogs[0].action, "Get <Offer>");
  assert.equal(parsed.incomingLogs[0].action, 'Create "Proposal"');
  assert.equal(parsed.incomingLogs[0].machineName, "machine&one");
});

test("maps all four raw payload flows", () => {
  assert.deepEqual(getManagementConsolePayloadRequest("id/1", "Outgoing", "sent"), {
    path: "/ManagementConsole/GetSentOutgoingPayload/id%2F1",
    flow: "IGW -> insurer request",
  });
  assert.equal(
    getManagementConsolePayloadRequest("id", "Outgoing", "received").flow,
    "insurer -> IGW response"
  );
  assert.equal(
    getManagementConsolePayloadRequest("id", "Incoming", "received").flow,
    "client -> IGW request"
  );
  assert.equal(
    getManagementConsolePayloadRequest("id", "Incoming", "sent").flow,
    "IGW -> client response"
  );
});

test("chunks payloads with format and continuation metadata", () => {
  const raw = JSON.stringify({ text: "x".repeat(25_000) });
  const first = chunkManagementConsolePayload(raw, 0, 50_000);
  assert.equal(first.format, "json");
  assert.equal(first.returnedChars, 24_000);
  assert.equal(first.nextOffset, 24_000);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncated, true);

  const last = chunkManagementConsolePayload(raw, first.nextOffset, 24_000);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextOffset, null);
  assert.equal(last.truncated, true);
});

test("keeps serialized escaped payload output under the MCP character limit", () => {
  const raw = '"\\n'.repeat(8_000);
  const chunk = chunkManagementConsolePayload(raw, 0, 24_000);
  const serialized = serializeManagementConsolePayloadResult(
    { logId: "synthetic", logType: "Outgoing", payloadSide: "sent" },
    { flow: "IGW -> insurer request", ...chunk }
  );
  const parsed = JSON.parse(serialized);
  assert.ok(serialized.length <= CHARACTER_LIMIT);
  assert.equal(parsed.returnedChars, parsed.payload.length);
  assert.equal(parsed.nextOffset, parsed.returnedChars);
  assert.equal(parsed.hasMore, true);
});

test("builds the DataTables body and enforces a seven-calendar-day window", () => {
  const request = buildManagementConsoleIncomingLogsRequest({
    beginDate: "2026-07-24",
    endDate: "2026-07-30",
    agentId: "0007",
    serviceOperationId: 1,
    page: 2,
    pageSize: 20,
  });
  const query = new URLSearchParams(request.query);
  const body = new URLSearchParams(request.body);
  assert.equal(request.path, "/ManagementConsole/GetIncomingLogs");
  assert.equal(query.get("agentId"), "0007");
  assert.equal(query.get("serviceOperationId"), "1");
  assert.equal(query.get("outSourceProcessId"), "");
  assert.equal(body.get("start"), "20");
  assert.equal(body.get("length"), "20");
  assert.equal(body.get("columns[4][data]"), "RequestDate");
  assert.equal(body.get("columns[4][valueType]"), "4");
  assert.equal(body.get("columns[4][search][value]"), "24.07.2026 - 30.07.2026");
  assert.equal(body.get("columns[7][data]"), "IpAddress");
  assert.equal(body.get("columns[7][orderable]"), "false");
  assert.equal(body.get("order[0][column]"), "0");
  assert.equal(body.get("order[0][dir]"), "asc");

  assert.throws(() =>
    buildManagementConsoleIncomingLogsRequest({
      beginDate: "2026-07-23",
      endDate: "2026-07-30",
    })
  );
});

test("projects incoming-list rows onto the eight documented fields", () => {
  const parsed = parseManagementConsoleIncomingLogsResponse(
    JSON.stringify({
      draw: 1,
      recordsTotal: 1,
      recordsFiltered: 1,
      data: [
        {
          Id: "log-1",
          ReferanceNo: "REF&amp;1",
          AgentId: 7,
          Action: "GetProposal",
          RequestDate: "30.07.2026",
          ElapsedTime: 12,
          MachineName: "machine-1",
          IpAddress: "192.0.2.1",
          UndocumentedSecret: "must-not-leak",
        },
      ],
    })
  );
  assert.deepEqual(parsed.data, [
    {
      logId: "log-1",
      referenceNo: "REF&1",
      agentId: "7",
      action: "GetProposal",
      requestDate: "30.07.2026",
      elapsedMs: "12",
      machineName: "machine-1",
      ipAddress: "192.0.2.1",
    },
  ]);
  assert.equal(JSON.stringify(parsed).includes("must-not-leak"), false);
});

test("detects a 200 login form and validates the post-login redirect", () => {
  const loginHtml = `<form action="/Account/Login"><input name="EmailOrUserName"><input name="__RequestVerificationToken" value="synthetic"></form>`;
  assert.equal(isManagementConsoleLoginHtml(loginHtml), true);
  assert.equal(isManagementConsoleLoginHtml("plain payload"), false);
  assert.equal(
    isManagementConsoleLoginRedirect(
      "/ManagementConsole",
      "https://portal.example.invalid"
    ),
    true
  );
  assert.equal(
    isManagementConsoleLoginRedirect("/", "https://portal.example.invalid"),
    false
  );
  assert.equal(
    isManagementConsoleLoginRedirect(
      "https://other.example.invalid/ManagementConsole",
      "https://portal.example.invalid"
    ),
    false
  );
});

test("requires HTTPS except for loopback-only test clients", () => {
  assert.throws(
    () =>
      new ManagementConsoleClient({
        baseUrl: "http://portal.example.invalid",
        username: "synthetic-user",
        password: "synthetic-password",
      })
  );
  assert.doesNotThrow(
    () =>
      new ManagementConsoleClient({
        baseUrl: "http://127.0.0.1:8080",
        username: "synthetic-user",
        password: "synthetic-password",
      })
  );
});

test("carries antiforgery cookies through login and retries one stale session", async (t) => {
  for (const expiryMode of ["redirect", "html"]) {
    await t.test(expiryMode, async () => {
      let loginPageCount = 0;
      let loginPostCount = 0;
      let searchCount = 0;
      const loginPosts = [];
      const searchRequests = [];

      await withLoopbackServer(async (request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/Account/Login") {
          loginPageCount += 1;
          response.setHeader("Set-Cookie", `antiforgery=af-${loginPageCount}; Path=/`);
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(
            `<form action="/Account/Login"><input name="EmailOrUserName"><input name="__RequestVerificationToken" value="token-${loginPageCount}"></form>`
          );
          return;
        }
        if (request.method === "POST" && url.pathname === "/Account/Login") {
          const body = await readRequestBody(request);
          loginPostCount += 1;
          loginPosts.push({
            cookie: String(request.headers.cookie ?? ""),
            returnUrl: url.searchParams.get("returnurl"),
            form: Object.fromEntries(new URLSearchParams(body)),
          });
          response.setHeader("Set-Cookie", `portalSession=session-${loginPostCount}; Path=/`);
          response.writeHead(302, { Location: "/ManagementConsole" });
          response.end();
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/ManagementConsole/GetLogListByRequestId"
        ) {
          if (url.searchParams.get("id") === "server-error") {
            response.writeHead(500, { "Content-Type": "text/plain" });
            response.end("SYNTHETIC_UPSTREAM_SECRET");
            return;
          }
          if (url.searchParams.get("id") === "forbidden") {
            response.writeHead(403, { "Content-Type": "text/plain" });
            response.end("SYNTHETIC_FORBIDDEN_SECRET");
            return;
          }
          searchCount += 1;
          searchRequests.push({
            cookie: String(request.headers.cookie ?? ""),
            requestedWith: request.headers["x-requested-with"],
            id: url.searchParams.get("id"),
            logLevel: url.searchParams.get("logLevel"),
          });
          if (searchCount === 1) {
            if (expiryMode === "redirect") {
              response.writeHead(302, { Location: "/Account/Login" });
              response.end();
            } else {
              response.writeHead(200, { "Content-Type": "text/html" });
              response.end(
                '<form action="/Account/Login"><input name="EmailOrUserName"><input name="__RequestVerificationToken" value="expired"></form>'
              );
            }
            return;
          }
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(
            '<script>managementConsole.outgoingLogs = `[["log-1","ref-1","proposal-1","Product","Action","30.07.2026","12"]]`; managementConsole.incomingLogs = `[]`;</script>'
          );
          return;
        }
        response.writeHead(404);
        response.end();
      }, async (baseUrl) => {
        const client = new ManagementConsoleClient({
          baseUrl,
          username: "synthetic-user",
          password: "synthetic-password",
        });
        const found = await client.search({
          searchType: "requestId",
          value: "request-1",
          includeInternalLogs: true,
        });
        assert.equal(found.outgoingLogs[0].logId, "log-1");
        assert.equal(loginPageCount, 2);
        assert.equal(loginPostCount, 2);
        assert.equal(searchCount, 2);
        assert.deepEqual(
          loginPosts.map((post) => ({
            hasAntiforgeryCookie: post.cookie.includes("antiforgery=af-"),
            returnUrl: post.returnUrl,
            user: post.form.EmailOrUserName,
            password: post.form.Password,
            token: post.form.__RequestVerificationToken,
          })),
          [
            {
              hasAntiforgeryCookie: true,
              returnUrl: "/ManagementConsole",
              user: "synthetic-user",
              password: "synthetic-password",
              token: "token-1",
            },
            {
              hasAntiforgeryCookie: true,
              returnUrl: "/ManagementConsole",
              user: "synthetic-user",
              password: "synthetic-password",
              token: "token-2",
            },
          ]
        );
        assert.equal(searchRequests[1].cookie.includes("portalSession=session-2"), true);
        assert.equal(searchRequests[1].requestedWith, "XMLHttpRequest");
        assert.equal(searchRequests[1].id, "request-1");
        assert.equal(searchRequests[1].logLevel, "2");

        await assert.rejects(
          client.search({ searchType: "requestId", value: "server-error" }),
          (error) => {
            assert.equal(error.code, "request_failed");
            assert.equal(error.status, 500);
            assert.equal(error.message.includes("SYNTHETIC_UPSTREAM_SECRET"), false);
            return true;
          }
        );
        await assert.rejects(
          client.search({ searchType: "requestId", value: "forbidden" }),
          (error) => {
            assert.equal(error.code, "request_failed");
            assert.equal(error.status, 403);
            assert.equal(error.message.includes("SYNTHETIC_FORBIDDEN_SECRET"), false);
            return true;
          }
        );
        assert.equal(loginPostCount, 2);
      });
    });
  }
});
