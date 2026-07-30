---
name: igw-error-management
description: MCP skill for IGW (InsurGateway) error management and ManagementConsole traffic inspection across test and production environments. Invoke for IGW errors, insurer request/response patterns, success rates, or reports.
author: yusufaltunbicak
version: "2.4.0"
tags:
  - igw
  - insurgateway
  - insurance
  - error-management
  - mcp
  - sigorta
  - entegrasyon
---

# IGW Error Management MCP Skill

Use this skill when the user wants to investigate, analyze, report on, or manage InsurGateway (IGW) integration errors. Covers error listing, log inspection, root cause analysis, success rate reports, and error status management for Turkish insurance integrations.

It also covers read-only ManagementConsole traffic inspection: search correlated logs with any portal identifier and retrieve raw IGW-to-insurer requests or insurer-to-IGW responses without forcing company-specific payloads into a shared schema.

## Environments

Two MCP server instances are available:

| Server | Prefix | Use Case |
|--------|--------|----------|
| `igw-error-management-test` | Test environment | Development, debugging, safe exploration |
| `igw-error-management-prod` | Production environment | Real production errors, live data |

**IMPORTANT:** Always confirm which environment the user intends. Default to **test** unless explicitly told otherwise. Production write operations (pin, status update, send report, bug report) should be confirmed with the user before execution.

## Tool Reference

### Error Queries (Read-Only)

#### `igw_errors_list` — List errors with filters

Returns grouped errors with categories and detailed error entries.

| Parameter | Type | Description |
|-----------|------|-------------|
| `BeginDate` | string (ISO 8601) | Start date filter (e.g. `2026-03-01T00:00:00`) |
| `EndDate` | string (ISO 8601) | End date filter |
| `AgentId` | number | Filter by agent/acente ID |
| `BranchId` | number | Filter by branch ID (Kasko, Trafik, etc.) |
| `ProductId` | number | Filter by product ID |
| `InsuranceCompanyId` | number | Filter by insurance company ID |
| `ServiceOperationId` | number | 1 = Teklif (Proposal), 2 = Polica (Policy) |
| `NotAnalysed` | boolean | Show only not-analysed errors |
| `Solved` | boolean | Show only solved errors |
| `InProgress` | boolean | Show only in-progress errors |
| `NothingToDo` | boolean | Show only nothing-to-do errors |
| `UserMistake` | boolean | Show only user-mistake errors |
| `ConnectionError` | boolean | Show only connection errors |
| `OperationTimeout` | boolean | Show only timeout errors |
| `ErrorQuery` | string | Free text search in error messages |
| `IncludeProducts` | boolean | Include product details in response |
| `ClientChannel` | string | Filter by client channel |
| `PageNumber` | number | Page number (default: 1) |
| `PageSize` | number | Items per page (default: 20) |
| `SortColumn` | string | Sort by: `GroupCount`, `AgentName`, `LastErrorDate`, `InsuranceCompanyName`, `ProductName` |
| `SortDescending` | boolean | Sort direction |

#### `igw_errors_summary` — Error statistics

Lightweight status counts per service operation. Same filters as `igw_errors_list` (without pagination). Great for quick overview dashboards.

#### `igw_errors_operations` — Service operations with error stats

Shows which operations (Teklif/Police) produce errors and their counts. Same filter options.

#### `igw_errors_logs` — Detailed error log entries

Returns error logs with request/response data. Same filters as `igw_errors_list`.

#### `igw_errors_log_detail` — Single error log detail

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | number | Error log ID |

Returns full request/response XML/JSON payload sent to the insurance company and response received. Essential for debugging specific integration failures.

#### `igw_errors_analyze` — Analyze a specific error

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | number | Error ID |

Returns analysis details including possible root causes, affected products, and resolution suggestions.

### ManagementConsole Traffic (Read-Only)

These tools require portal credentials. `IGW_PORTAL_USERNAME` / `IGW_PORTAL_PASSWORD` take precedence. Reusing `IGW_PANEL_USERNAME` / `IGW_PANEL_PASSWORD` requires the explicit `IGW_PORTAL_USE_PANEL_CREDENTIALS=true` opt-in.

The portal environment is controlled by `IGW_PORTAL_BASE_URL`, not `IGW_BASE_URL`. Its default is the production portal; treat ManagementConsole reads as production even when the surrounding MCP instance is named test unless an explicit non-production portal URL is configured.

#### `igw_management_console_search` — Search correlated portal logs

| Parameter | Type | Description |
|-----------|------|-------------|
| `searchType` | string | `requestId`, `proposalId`, `referanceNo`, `exceptionLogId`, `policyId`, `jobId`, `insuranceCompanyProposalId`, or `platformProposalId` |
| `value` | string | Exact identifier; keep it as a string |
| `includeInternalLogs` | boolean | Include the portal's internal-log level; default false |
| `direction` | string | `all`, `outgoing`, or `incoming`; default all |
| `page` / `pageSize` | number | Page over structured search rows |

The portal intentionally spells the reference mode `referanceNo`. One company proposal number may correlate to several insurer rows for the same main proposal, so do not assume the result belongs only to the company that issued the searched number.

#### `igw_management_console_payload` — Retrieve a raw request or response

| Parameter | Type | Description |
|-----------|------|-------------|
| `logId` | string | Log ID returned by search or log discovery |
| `logType` | string | `Outgoing` or `Incoming` |
| `payloadSide` | string | `sent` or `received` |
| `offset` | number | Character offset for chunked retrieval |
| `maxChars` | number | Chunk size, bounded by the MCP response limit |

Direction mapping:

| Log type | Sent | Received |
|----------|------|----------|
| `Outgoing` | IGW → insurance company request | Insurance company → IGW response |
| `Incoming` | IGW → client response | Client → IGW request |

The result reports payload format (`json`, `xml`, or `text`), total length, offset, `hasMore`, and `nextOffset`. Continue until `hasMore` is false when the complete raw pattern is needed.

#### `igw_management_console_logs_list` — Discover incoming logs

| Parameter | Type | Description |
|-----------|------|-------------|
| `beginDate` / `endDate` | string | ISO date or datetime; maximum seven-calendar-day inclusive range |
| `agentId` | string or number | Optional final agent/acente ID |
| `serviceOperationId` | string or number | Optional service-operation filter |
| `outSourceProcessId` | string or number | Optional outsource-process filter |
| `insuranceCompanyId` | string or number | Optional insurer filter |
| `page` / `pageSize` | number | Server-side DataTables page |

Use this discovery tool when no proposal-producing insurer number is available. Narrow by date and agent first, then use the returned log ID with the payload tool.

### Reports (Read-Only)

All report tools share these parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `BeginDate` | string (ISO 8601) | Start date |
| `EndDate` | string (ISO 8601) | End date |
| `AgentId` | number | Filter by agent |
| `BranchId` | number | Filter by branch |
| `ProductId` | number | Filter by product |
| `InsuranceCompanyId` | number | Filter by company |
| `ServiceOperationId` | number | 1 = Teklif, 2 = Police |

#### `igw_errors_success_rate` — Overall success/failure rates

Breakdown by Genel (Overall), Teklifler (Proposals), Policeler (Policies).

#### `igw_errors_report_by_branch` — Report by branch

Error breakdown by branch: Kasko, Trafik, Tamallayici Saglik, DASK, etc.

#### `igw_errors_report_by_company` — Report by insurance company

Error breakdown by company: Allianz, Zurich, Doga, Bereket, etc.

#### `igw_errors_report_by_agent` — Report by agent

Error breakdown by acente/agent with success rates.

### Error Actions (Write Operations)

#### `igw_errors_pin` — Pin/unpin error

| Parameter | Type | Description |
|-----------|------|-------------|
| `errorId` | number | Error ID to pin/unpin |
| `isPinned` | boolean | `true` to pin, `false` to unpin |

#### `igw_errors_update_status` — Update analysis status

| Parameter | Type | Description |
|-----------|------|-------------|
| `errorExplanationHash` | string | Error explanation hash identifier |
| `analyzeStatus` | number | Status value (0-6, see table below) |
| `serviceOperationId` | number | Optional: 1 = Teklif, 2 = Police |

#### `igw_errors_send_report` — Send error report to team

| Parameter | Type | Description |
|-----------|------|-------------|
| `errorId` | number | Error ID |
| `description` | string | Report description explaining the issue |

#### `igw_errors_send_bug_report` — File a bug report

| Parameter | Type | Description |
|-----------|------|-------------|
| `referenceNo` | string | Reference number (e.g. `IGW-12345`) |

### Lookups (Read-Only)

#### `igw_products_search` — Search insurance products

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Product name search (e.g. "Allianz Kasko", "Bereket Trafik") |
| `page` | number | Page number |
| `pageSize` | number | Items per page |

Returns product IDs for use as filters in other tools.

#### `igw_products_list` — Full product catalog (GatewayProUI panel)

Richer than `igw_products_search`: returns GW product code (Id), insurance company's own product code(s), branch, online/offline and active status. Needs `IGW_PANEL_USERNAME` / `IGW_PANEL_PASSWORD`; otherwise the tool is absent. All filters combine with AND; matching is local and Turkish-case-insensitive.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Substring on product name (e.g. "Konut", "Kasko Offline") |
| `insuranceCompany` | string | Numeric ID exact (e.g. "7") or name substring (e.g. "Anadolu") |
| `branch` | string | Numeric branch ID exact or name substring (e.g. "Konut Yangın") |
| `gwProductId` | number | Exact GW product code lookup (e.g. 1523) |
| `companyProductCode` | string | Matches one of the comma-separated company codes exactly (e.g. "722") |
| `isOnline` | boolean | Online (true) / offline (false) products |
| `isActive` | boolean | Active / passive status |
| `productType` | number | 0=Default, 1=Yarı Online, 2=Dinamik, 3=AIR |
| `hasPolicyInLastThreeMonths` | boolean | Produced a policy in the last 3 months |
| `refresh` | boolean | Bypass the 10-minute cache |
| `page` / `pageSize` | number | Pagination over filtered result (default 1 / 50) |

Example: "Anadolu Sigorta'daki konut yangın ürünlerinin GW kodları" → `insuranceCompany: "Anadolu", branch: "Konut Yangın"` → 1523 "Anadolu Sigorta Konut Offline" (offline, şirket kodu 722,732) and 3251 "Anadolu Sigorta Konut" (online, şirket kodu yok).

#### `igw_keys_list` — Request/response key catalog (GatewayProUI panel)

Field definitions used to build insurance company request/response mappings. Needs `IGW_PANEL_USERNAME` / `IGW_PANEL_PASSWORD`; otherwise absent. Returns key Id, name, value type, parameterized flag, ParameterId + resolved ParameterName (resolved from the parameter catalog since the key list leaves it null), Depent (dependent) flag and active status. All filters combine with AND; matching is local and Turkish-case-insensitive.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Substring on key name (e.g. "T.C. Kimlik", "Plaka") |
| `keyId` | number | Exact key Id lookup |
| `keyValueType` | string | Value type: "string", "int", "decimal", "datetime", "double", "json" |
| `parameterized` | boolean | Only parameter-backed keys (true) / non-parameterized (false) |
| `parameterId` | number | Exact parameter Id the key is bound to |
| `parameterName` | string | Substring on the resolved parameter name (e.g. "İller", "Marka") |
| `dependent` | boolean | Filter by the Depent flag (value depends on another key) |
| `isActive` | boolean | Active / passive status |
| `refresh` | boolean | Bypass the 10-minute cache |
| `page` / `pageSize` | number | Pagination over filtered result (default 1 / 50) |

Example: "Sigortalı Türü key'inin parametresi ne" → `query: "Sigortalı Türü"` → key 3, value type string, parameterized, ParameterId 6 → "Müşteri Türü".

#### Panel catalog tools (read-only, GatewayProUI)

All require `IGW_PANEL_USERNAME` / `IGW_PANEL_PASSWORD`; otherwise absent. All read-only. Filters combine with AND, matching is local and Turkish-case-insensitive, and results paginate with `page` / `pageSize`. Cached tools also accept `refresh`.

Full-fetch + local filter (cached ~10 min):

| Tool | Key filters |
|------|-------------|
| `igw_product_branches_list` | query, branchId, branchGroup, category |
| `igw_related_products_list` | query, productId |
| `igw_guarantee_descriptions_list` | query, guaranteeDescId, branch(id/name), isActive, isAgentRelated |
| `igw_guarantee_product_mappings_list` | query, guaranteeDescId, productId, productName, isFreeWord, isSQL |
| `igw_guarantee_freeword_dependencies_list` | query, productId, guaranteeDescId |
| `igw_provided_services_list` | query, methodName, insuranceCompany(id/name), productId, productName |
| `igw_key_relations_list` | query, keyId, keyRelationId, serviceOperationId, branch, agentId, mandatory, isActive, dependent |
| `igw_parameters_list` | query, parameterId, dependent |
| `igw_insurance_companies_list` | query, companyId, companyType |
| `igw_connection_groups_list` | query, insuranceCompany(id/name), category |
| `igw_outsource_processes_list` | query, insuranceCompany(id/name) |
| `igw_agents_list` | query, agentId, parentId, agentType, isActive |
| `igw_agent_connection_infos_list` | query, agentId, insuranceCompany, connectionGroupId, isActive, environmentType |
| `igw_dynamic_forms_list` | query, formId, agentId, agentName |

Server-side paged (huge tables; filters narrow the fetched page only, they do **not** scan the whole table):

| Tool | ~Rows | Page filters |
|------|------:|--------------|
| `igw_agent_connections_list` | 63k | agentId, agentName, insuranceCompany, isActive |
| `igw_users_list` | 21k | query (name/email/username), role, disabled — returns PII |
| `igw_action_logs_list` | ~5M | requestId, userName, responseStatus, requestChannel, machineName |

Note: the panel's DataTables endpoints 500 on server-side column search and ignore global search, so filtering is client-side after fetch. For the three paged tools, filters therefore only narrow the current page — to find a specific row walk pages with `page`/`pageSize`.

#### `igw_insurance_companies` — List all insurance companies

No parameters. Returns company IDs and names. Common companies:

| ID | Company |
|----|---------|
| 45 | Allianz |
| 18 | Zurich |
| 43 | Doga Sigorta |
| 57 | Bereket Sigorta |

## Error Analysis Status Values

| Value | Turkish | English | Use When |
|-------|---------|---------|----------|
| 0 | Analiz Edilmedi | Not Analysed | Default state, not yet reviewed |
| 1 | Inceleniyor | In Progress | Currently being investigated |
| 2 | Cozuldu | Solved | Fix has been applied |
| 3 | Sirket Kurali / Onlenemez Hata | Nothing To Do | Insurance company rule, cannot be fixed |
| 4 | Kullanici Hatasi | User Mistake | End user input error |
| 5 | Servis Baglanti Hatasi | Connection Error | Service connectivity issue |
| 6 | Zaman Asimi | Operation Timeout | Request timed out |

## Common Workflows

### Quick daily error check

```
1. igw_errors_summary (last 24h) → get status overview
2. igw_errors_list (NotAnalysed=true, last 24h) → find new unreviewed errors
3. igw_errors_success_rate (last 24h) → check overall health
```

### Investigate a specific error

```
1. igw_errors_list (with filters) → find the error group
2. igw_errors_logs (same filters) → get log entries
3. igw_errors_log_detail (id) → inspect full request/response payload
4. igw_errors_analyze (id) → get root cause analysis
5. igw_errors_update_status → mark as investigated
```

### Inspect an insurer integration pattern

```
1. Take a premium-producing insurer proposal number from the latest proposal
2. igw_management_console_search (insuranceCompanyProposalId) → find all correlated company rows
3. Select the relevant Outgoing logId
4. igw_management_console_payload (Outgoing, sent) → IGW-to-company request
5. igw_management_console_payload (Outgoing, received) → company-to-IGW response
6. Follow nextOffset until hasMore=false for any chunked payload
```

If no insurer produced a proposal, find a reference number in the admin flow and search with `referanceNo`; otherwise use `igw_management_console_logs_list` with a narrow date range and agent filter.

### Company-specific error analysis

```
1. igw_insurance_companies → get company ID
2. igw_errors_report_by_company (date range) → see which companies have issues
3. igw_errors_list (InsuranceCompanyId=X) → drill into specific company errors
4. igw_errors_logs → inspect detailed failures
```

### Branch performance report

```
1. igw_errors_report_by_branch (date range) → branch-level success rates
2. igw_errors_report_by_company (BranchId=X) → which companies fail in that branch
3. igw_errors_list (BranchId=X, SortColumn=GroupCount, SortDescending=true) → most frequent errors
```

### Product search and filter

```
1. igw_products_search (query="Kasko") → find product IDs
2. igw_errors_list (ProductId=X) → errors for that specific product
```

### Error triage workflow

```
1. igw_errors_list (NotAnalysed=true, SortColumn=GroupCount, SortDescending=true) → highest impact first
2. igw_errors_analyze (id) → understand the error
3. igw_errors_update_status → categorize (Solved, UserMistake, ConnectionError, etc.)
4. igw_errors_send_report (if needed) → notify the team
5. igw_errors_send_bug_report (if genuine bug) → file with IGW team
```

### Track a pinned error

```
1. igw_errors_pin (errorId, isPinned=true) → pin for follow-up
2. igw_errors_list (date range) → check if error recurs
3. igw_errors_pin (errorId, isPinned=false) → unpin when resolved
```

## Agent Best Practices

- **Date ranges:** Always use ISO 8601 format. For "last 24 hours", calculate from current time. For "today", use midnight to now.
- **Pagination:** Start with `PageSize=20`. If user needs more, increase or paginate.
- **Sorting:** Default to `LastErrorDate` descending for recent errors, `GroupCount` descending for most frequent.
- **Error investigation:** Always check `igw_errors_log_detail` before concluding on root cause — the request/response payload is the ground truth.
- **Status updates on prod:** Always confirm with the user before changing error status in production.
- **Reports:** When user asks for "error report", clarify if they want by branch, company, or agent — or provide all three for a comprehensive view.
- **Turkish context:** Many field values are in Turkish (branch names, error messages). Be prepared to translate or explain when needed.
- **Service operations:** Teklif = Proposal (quote request), Police = Policy (policy issuance). These are the two main operation types.
- **Free text search:** Use `ErrorQuery` parameter for searching specific error messages, XML tags, or insurance company error codes.
- **Large responses:** Results are auto-truncated at 25,000 characters. If data seems incomplete, narrow filters or reduce page size.
- **Insurer payloads:** Preserve raw XML/JSON/text. Similar-looking companies can still have materially different contracts.
- **ManagementConsole identifiers:** Pass them as strings. Prefer a premium-producing company proposal number; it can reveal correlated requests for the other companies on the same proposal.
- **Payload direction:** For insurer traffic use `logType=Outgoing`; `sent` is IGW-to-company and `received` is company-to-IGW.

## Safety Notes

- **Environment awareness:** Always verify test vs production before write operations.
- **Status changes:** Updating error status affects the team's workflow. Confirm with user before bulk status updates.
- **Bug reports:** `igw_errors_send_bug_report` sends to the IGW team. Only use for genuine bugs, not user errors or known issues.
- **Error reports:** `igw_errors_send_report` sends to the internal team. Include clear, actionable descriptions.
- **Credentials:** MCP server handles authentication automatically. Never ask users for IGW credentials in chat.
