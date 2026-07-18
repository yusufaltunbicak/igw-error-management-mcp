import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PanelClient } from "../services/panel.js";
import {
  registerCachedListTool,
  registerPagedListTool,
  strContains,
  strContainsAny,
  numEquals,
  boolEquals,
  idOrName,
} from "./panel-lists.js";

type Row = Record<string, unknown>;

const pick = (row: Row, fields: string[]): Row => {
  const out: Row = {};
  for (const f of fields) out[f] = row[f];
  return out;
};

const preview = (value: unknown, max = 500): unknown => {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(0, max) + "…" : value;
};

/**
 * Register every read-only GatewayProUI panel list tool. The 14
 * small/medium catalogs use full-fetch + local filtering + cache; the
 * three huge tables (agent connections, users, action logs) use
 * server-side pagination.
 */
export function registerPanelCatalogTools(
  server: McpServer,
  panel: PanelClient
): void {
  // ── Ürün & Teminat ──────────────────────────────────────────────

  registerCachedListTool(server, panel, {
    tool: "igw_product_branches_list",
    description:
      "List IGW product branches (Ürün Branşları) from the GatewayProUI panel: branch Id, name, branch group and category. Filters combine with AND; matching is local and Turkish-case-insensitive.",
    endpoint: "ProductBranch/GetProductBranches",
    resultKey: "branches",
    filters: [
      strContains("query", "Name", "Substring on branch name (e.g. 'Kasko', 'Konut')"),
      numEquals("branchId", "Id", "Exact branch Id"),
      strContains("branchGroup", "BranchGroup", "Substring on branch group"),
      strContains("category", "Category", "Substring on category"),
    ],
    project: (r) => pick(r, ["Id", "Name", "BranchGroup", "Category", "CreateDate"]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_related_products_list",
    description:
      "List IGW related-product definitions (İlişkili Ürün Yönetimi): a product and the products related to it. Filters combine with AND.",
    endpoint: "Product/GetRelatedProducts",
    resultKey: "relatedProducts",
    filters: [
      strContains("query", "ProductName", "Substring on product name"),
      numEquals("productId", "ProductId", "Exact GW product Id"),
    ],
    project: (r) => pick(r, ["ProductId", "ProductName", "RelatedProducts"]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_guarantee_descriptions_list",
    description:
      "List IGW guarantee descriptions (Teminat Açıklamaları): guarantee Id, name, product branch, order and status. Filters combine with AND.",
    endpoint: "OfferGuaranteeDesc/GetOfferGuaranteeDescriptions",
    resultKey: "guaranteeDescriptions",
    filters: [
      strContains("query", "OfferGuaranteeName", "Substring on guarantee name (e.g. 'ÇARPIŞMA')"),
      numEquals("guaranteeDescId", "OfferGuaranteeDescId", "Exact guarantee description Id"),
      idOrName("branch", "ProductBranchId", "ProductBranchName", "Product branch: numeric Id or name substring"),
      boolEquals("isActive", "Status", "true = active only, false = passive only"),
      boolEquals("isAgentRelated", "IsAgentRelated", "Filter by whether the guarantee is agent-specific"),
    ],
    project: (r) =>
      pick(r, [
        "OfferGuaranteeDescId",
        "OfferGuaranteeName",
        "ProductBranchId",
        "ProductBranchName",
        "OrderNo",
        "Status",
        "IsAgentRelated",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_guarantee_product_mappings_list",
    description:
      "List IGW guarantee-to-product mappings (Ürün Eşleşmeleri): which guarantee maps to which product, with its guarantee Id / free-word / SQL / proposal-key configuration. Filters combine with AND.",
    endpoint: "OfferGuaranteeDescProductMapping/GetOfferGuaranteeDescProductMappings",
    resultKey: "mappings",
    filters: [
      strContains("query", "OfferGuaranteeName", "Substring on guarantee name"),
      numEquals("guaranteeDescId", "OfferGuaranteeDescId", "Exact guarantee description Id"),
      numEquals("productId", "ProductId", "Exact GW product Id"),
      strContains("productName", "ProductName", "Substring on product name"),
      boolEquals("isFreeWord", "IsFreeWord", "Only free-word mappings"),
      boolEquals("isSQL", "IsSQL", "Only SQL-based mappings"),
    ],
    project: (r) =>
      pick(r, [
        "OfferGuaranteeDescId",
        "OfferGuaranteeName",
        "OfferGuaranteeDescName",
        "ProductId",
        "ProductName",
        "IsOfferGuaranteeId",
        "OfferGuaranteeId",
        "IsOfferGuaranteeAmount",
        "IsFreeWord",
        "FreeWord",
        "IsSQL",
        "TSQL",
        "IsProposalKeyValue",
        "ProposalKeyId",
        "HasScope",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_guarantee_freeword_dependencies_list",
    description:
      "List IGW guarantee free-word dependency definitions (Serbest Metin Bağımlılıkları): the free-word dependency rules attached to a guarantee/product. Filters combine with AND.",
    endpoint:
      "OfferGuaranteeDescFreeWordDependencyDefinition/GetOfferGuaranteeDescFreeWordDependencyDefinitions",
    resultKey: "freeWordDependencies",
    filters: [
      strContains("query", "OfferGuaranteeName", "Substring on guarantee name"),
      numEquals("productId", "ProductId", "Exact GW product Id"),
      numEquals("guaranteeDescId", "OfferGuaranteeDescId", "Exact guarantee description Id"),
    ],
    project: (r) =>
      pick(r, [
        "DependencyDefinitionId",
        "OfferGuaranteeDescId",
        "OfferGuaranteeName",
        "ProductId",
        "ProductName",
        "DependencyExplanation",
        "FreeWord",
        "DependecyDefinationName",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_provided_services_list",
    description:
      "List InsurGateway-provided service implementations (Kullanıma Açık Servisler): service/method/class names mapped to insurance company and product. Filters combine with AND.",
    endpoint: "InsurGatewayProvided/GetOperationImplementations",
    resultKey: "services",
    filters: [
      strContains("query", "ServiceName", "Substring on service name"),
      strContains("methodName", "MethodName", "Substring on method name"),
      idOrName("insuranceCompany", "InsuranceCompanyId", "InsuranceCompanyName", "Insurance company: numeric Id or name substring"),
      numEquals("productId", "ProductId", "Exact GW product Id"),
      strContains("productName", "ProductName", "Substring on product name"),
    ],
    project: (r) =>
      pick(r, [
        "ServiceName",
        "MethodName",
        "ClassName",
        "ProductId",
        "ProductName",
        "InsuranceCompanyId",
        "InsuranceCompanyName",
      ]),
  });

  // ── Key & Parametre ─────────────────────────────────────────────

  registerCachedListTool(server, panel, {
    tool: "igw_key_relations_list",
    description:
      "List IGW key relations (KeyRelation): which key is bound to which service operation / branch / agent, plus mandatory, status, dependent and default-value flags. Filters combine with AND.",
    endpoint: "KeyRelation/GetKeyRelations",
    resultKey: "keyRelations",
    filters: [
      strContains("query", "KeyName", "Substring on key name"),
      numEquals("keyId", "KeyId", "Exact key Id"),
      numEquals("keyRelationId", "KeyRelationId", "Exact key relation Id"),
      numEquals("serviceOperationId", "ServiceOperationId", "Service operation Id (1=Teklif, 2=Poliçe)"),
      idOrName("branch", "ProductBranchId", "ProductBranchName", "Product branch: numeric Id or name substring"),
      numEquals("agentId", "AgentId", "Exact agent Id"),
      boolEquals("mandatory", "Mandatory", "Only mandatory (or non-mandatory) relations"),
      boolEquals("isActive", "Status", "true = active only, false = passive only"),
      boolEquals("dependent", "Dependent", "Filter by dependent flag"),
    ],
    project: (r) =>
      pick(r, [
        "KeyRelationId",
        "KeyId",
        "KeyName",
        "ServiceOperationId",
        "ServiceOperation",
        "AgentId",
        "AgentName",
        "ProductBranchId",
        "ProductBranchName",
        "Mandatory",
        "Status",
        "Dependent",
        "HasDefaultValue",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_parameters_list",
    description:
      "List IGW parameters (Parametre Yönetimi): parameter Id, name and dependent flag. These are the value lists that parameterized keys draw from. Filters combine with AND.",
    endpoint: "Parameter/GetParameters",
    resultKey: "parameters",
    filters: [
      strContains("query", "ParameterName", "Substring on parameter name (e.g. 'İller', 'Marka')"),
      numEquals("parameterId", "ParameterId", "Exact parameter Id"),
      boolEquals("dependent", "Dependent", "Filter by dependent flag"),
    ],
    project: (r) => pick(r, ["ParameterId", "ParameterName", "Dependent"]),
  });

  // ── Sigorta Şirketi & Bağlantı ──────────────────────────────────

  registerCachedListTool(server, panel, {
    tool: "igw_insurance_companies_list",
    description:
      "List insurance companies from the GatewayProUI panel (Sigorta Şirketleri) with connection settings: Id, name, company type, email, authorization type and allowed IP addresses. Richer than igw_insurance_companies (which comes from the gateway API). Filters combine with AND.",
    endpoint: "InsuranceCompany/GetInsuranceCompanies",
    resultKey: "insuranceCompanies",
    filters: [
      strContains("query", "Name", "Substring on company name (e.g. 'Anadolu')"),
      numEquals("companyId", "Id", "Exact insurance company Id"),
      strContains("companyType", "CompanyType", "Substring on company type"),
    ],
    project: (r) =>
      pick(r, [
        "Id",
        "Name",
        "CompanyType",
        "Email",
        "CreateDate",
        "NeedAuthorizationHeader",
        "AuthorizationType",
        "IpAddresses",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_connection_groups_list",
    description:
      "List IGW insurance-company connection groups (Şirket Bağlantı Grupları): group Id/name, company, category, and the products & service types in each group. Filters combine with AND.",
    endpoint: "ICConnectionGroup/GetConnectionGroups",
    resultKey: "connectionGroups",
    filters: [
      strContains("query", "GroupName", "Substring on group name"),
      idOrName("insuranceCompany", "InsuranceCompanyId", "InsuranceCompanyName", "Insurance company: numeric Id or name substring"),
      strContains("category", "Category", "Substring on category"),
    ],
    project: (r) =>
      pick(r, [
        "Id",
        "InsuranceCompanyId",
        "InsuranceCompanyName",
        "GroupName",
        "Category",
        "CreateDate",
        "Products",
        "ServiceTypes",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_outsource_processes_list",
    description:
      "List IGW outsource processes (Outsource Process Yönetimi): process Id, name and its insurance company. Filters combine with AND.",
    endpoint: "OutSourceProcess/GetOutSourceProcesses",
    resultKey: "outsourceProcesses",
    filters: [
      strContains("query", "Name", "Substring on process name"),
      idOrName("insuranceCompany", "InsuranceCompanyId", "InsuranceCompanyName", "Insurance company: numeric Id or name substring"),
    ],
    project: (r) => pick(r, ["Id", "Name", "InsuranceCompanyId", "InsuranceCompanyName"]),
  });

  // ── Acente ──────────────────────────────────────────────────────

  registerCachedListTool(server, panel, {
    tool: "igw_agents_list",
    description:
      "List IGW agents (Acente Yönetimi): agent code (Id), name, parent agent, agent type and active status. Filters combine with AND.",
    endpoint: "Agent/GetAgents",
    resultKey: "agents",
    filters: [
      strContains("query", "AgentName", "Substring on agent name"),
      numEquals("agentId", "Id", "Exact agent code (Id)"),
      numEquals("parentId", "ParentId", "Exact parent agent Id"),
      numEquals("agentType", "AgentType", "Exact agent type"),
      boolEquals("isActive", "Status", "true = active only, false = passive only"),
    ],
    project: (r) =>
      pick(r, ["Id", "AgentName", "ParentId", "ParentAgentName", "AgentType", "Status"]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_agent_connection_infos_list",
    description:
      "List IGW agent connection info records (Acente Bağlantı Bilgileri): an agent's connection to an insurance company via a connection group, with environment, status and the products/service types it covers. Filters combine with AND.",
    endpoint: "AgentConnectionInfo/GetAgentConnections",
    resultKey: "agentConnectionInfos",
    filters: [
      strContains("query", "AgentName", "Substring on agent name"),
      numEquals("agentId", "AgentId", "Exact agent Id"),
      idOrName("insuranceCompany", "InsuranceCompanyId", "InsuranceCompanyName", "Insurance company: numeric Id or name substring"),
      numEquals("connectionGroupId", "ConnectionGroupId", "Exact connection group Id"),
      boolEquals("isActive", "Status", "true = active only, false = passive only"),
      numEquals("environmentType", "EnvironmentType", "Exact environment type"),
    ],
    project: (r) =>
      pick(r, [
        "Id",
        "AgentId",
        "AgentName",
        "InsuranceCompanyId",
        "InsuranceCompanyName",
        "ConnectionGroupId",
        "GroupName",
        "UseForSubAgents",
        "Status",
        "EnvironmentType",
        "CreateDate",
        "Products",
        "ServiceTypes",
      ]),
  });

  registerCachedListTool(server, panel, {
    tool: "igw_dynamic_forms_list",
    description:
      "List IGW dynamic forms (DynamicForm): form Id, owning agent, name, explanation and relation. Filters combine with AND.",
    endpoint: "DynamicForm/GetDynamicForms",
    resultKey: "dynamicForms",
    filters: [
      strContains("query", "Name", "Substring on form name"),
      numEquals("formId", "Id", "Exact form Id"),
      numEquals("agentId", "AgentId", "Exact agent Id"),
      strContains("agentName", "AgentName", "Substring on agent name"),
    ],
    project: (r) => pick(r, ["Id", "AgentId", "AgentName", "Name", "Explanation", "Relation"]),
  });

  // ── Büyük tablolar: server-side paging ──────────────────────────

  registerPagedListTool(server, panel, {
    tool: "igw_agent_connections_list",
    description:
      "List IGW agent↔insurance-company service connections (Acente Bağlantıları, ~63k rows) via SERVER-SIDE PAGING. Use page/pageSize to walk the table; any filters apply to the fetched page only (they do not scan all 63k). Each row: service connection Id, agent, insurance company, status and the products/service types.",
    endpoint: "AgentConnection/GetAgentConnectionsV2",
    resultKey: "agentConnections",
    filters: [
      numEquals("agentId", "AgentId", "Keep only rows with this agent Id (within the fetched page)"),
      strContains("agentName", "Agent", "Substring on agent name (within the fetched page)"),
      idOrName("insuranceCompany", "InsuranceCompanyId", "InsuranceCompanyName", "Insurance company id/name (within the fetched page)"),
      boolEquals("isActive", "Status", "Active/passive (within the fetched page)"),
    ],
    project: (r) =>
      pick(r, [
        "ICServiceConnectionId",
        "AgentId",
        "Agent",
        "InsuranceCompanyId",
        "InsuranceCompanyName",
        "Status",
        "CreateDate",
        "Products",
        "ServiceTypes",
      ]),
  });

  registerPagedListTool(server, panel, {
    tool: "igw_users_list",
    description:
      "List GatewayProUI panel users (Kullanıcı Yönetimi, ~21k rows) via SERVER-SIDE PAGING. Use page/pageSize to walk the table; any filters apply to the fetched page only (they do not scan all users). Returns PII (email, phone, roles) — handle accordingly.",
    endpoint: "User/GetUsers",
    resultKey: "users",
    filters: [
      strContainsAny("query", ["FullName", "Email", "UserName"], "Substring on name/email/username (within the fetched page)"),
      strContains("role", "AssignedRoles", "Substring on assigned roles (within the fetched page)"),
      strContains("disabled", "Disabled", "'True' or 'False' — account disabled flag (within the fetched page)"),
    ],
    project: (r) =>
      pick(r, [
        "Id",
        "FullName",
        "Email",
        "UserName",
        "PhoneNumber",
        "AssignedRoles",
        "Disabled",
        "EmailConfirmed",
        "TwoFactorEnabled",
        "LastLogin",
        "LockoutEnd",
      ]),
  });

  registerPagedListTool(server, panel, {
    tool: "igw_action_logs_list",
    description:
      "List InsurGateway request/response action logs (Action Logs, ~5M rows) via SERVER-SIDE PAGING in the panel's default order. Use page/pageSize to walk the table; any filters apply to the fetched page ONLY (the endpoint does not support server-side search, so this cannot look up an arbitrary RequestId across all 5M rows — it narrows what the current page returned). Request/ApiResponse bodies are previewed to 500 chars.",
    endpoint: "ActionLog/GetActionLogs",
    resultKey: "actionLogs",
    filters: [
      strContains("requestId", "RequestId", "Substring on RequestId (within the fetched page)"),
      strContains("userName", "UserName", "Substring on user name (within the fetched page)"),
      numEquals("responseStatus", "ResponseStatus", "Exact HTTP response status (within the fetched page)"),
      strContains("requestChannel", "RequestChannel", "Substring on request channel, e.g. 'WEBAPI' (within the fetched page)"),
      strContains("machineName", "MachineName", "Substring on server/machine name (within the fetched page)"),
    ],
    project: (r) => ({
      Id: r.Id,
      RequestId: r.RequestId,
      UserName: r.UserName,
      RequestTimeUTC: r.RequestTimeUTC,
      ElapsedMiliseconds: r.ElapsedMiliseconds,
      ResponseStatus: r.ResponseStatus,
      RequestChannel: r.RequestChannel,
      MachineName: r.MachineName,
      Request: preview(r.Request),
      ApiResponse: preview(r.ApiResponse),
    }),
  });
}
