#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IgwApiClient } from "./services/api.js";
import { PanelClient } from "./services/panel.js";
import { ManagementConsoleClient } from "./services/management-console.js";
import { IgwAuthConfig } from "./types.js";
import {
  DEFAULT_IGW_BASE_URL,
  DEFAULT_PANEL_BASE_URL,
  DEFAULT_PORTAL_BASE_URL,
} from "./constants.js";
import { registerErrorTools } from "./tools/errors.js";
import { registerErrorActionTools } from "./tools/error-actions.js";
import { registerReportTools } from "./tools/reports.js";
import { registerLookupTools } from "./tools/lookups.js";
import { registerProductTools } from "./tools/products.js";
import { registerKeyTools } from "./tools/keys.js";
import { registerPanelCatalogTools } from "./tools/panel-catalog.js";
import { registerManagementConsoleTools } from "./tools/management-console.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const config: IgwAuthConfig = {
  baseUrl: process.env.IGW_BASE_URL || DEFAULT_IGW_BASE_URL,
  username: getRequiredEnv("IGW_USERNAME"),
  password: getRequiredEnv("IGW_PASSWORD"),
  webApiKey: getRequiredEnv("IGW_WEB_API_KEY"),
};

const api = new IgwApiClient(config);

const server = new McpServer({
  name: "igw-error-management",
  version: "2.4.0",
});

registerErrorTools(server, api);
registerErrorActionTools(server, api);
registerReportTools(server, api);
registerLookupTools(server, api);

// Product catalog via GatewayProUI admin panel — optional, needs panel credentials
const panelUsername = process.env.IGW_PANEL_USERNAME;
const panelPassword = process.env.IGW_PANEL_PASSWORD;
if (panelUsername && panelPassword) {
  const panel = new PanelClient({
    baseUrl: process.env.IGW_PANEL_BASE_URL || DEFAULT_PANEL_BASE_URL,
    username: panelUsername,
    password: panelPassword,
  });
  registerProductTools(server, panel);
  registerKeyTools(server, panel);
  registerPanelCatalogTools(server, panel);
} else {
  console.error(
    "IGW_PANEL_USERNAME / IGW_PANEL_PASSWORD not set — panel tools (products, keys, branches, agents, users, logs, …) disabled"
  );
}

// Management Console uses a separate portal session. Reusing panel
// credentials for the portal requires an explicit opt-in.
const explicitPortalUsername = process.env.IGW_PORTAL_USERNAME;
const explicitPortalPassword = process.env.IGW_PORTAL_PASSWORD;
const hasExplicitPortalCredentials = Boolean(
  explicitPortalUsername && explicitPortalPassword
);
const hasPartialPortalCredentials =
  Boolean(explicitPortalUsername) !== Boolean(explicitPortalPassword);
const reusePanelCredentials = /^(?:1|true|yes)$/i.test(
  process.env.IGW_PORTAL_USE_PANEL_CREDENTIALS || ""
);
if (hasPartialPortalCredentials) {
  console.error(
    "Only one of IGW_PORTAL_USERNAME / IGW_PORTAL_PASSWORD is set; Management Console tools disabled"
  );
}
const portalUsername = hasExplicitPortalCredentials
  ? explicitPortalUsername
  : !hasPartialPortalCredentials && reusePanelCredentials
  ? panelUsername
  : undefined;
const portalPassword = hasExplicitPortalCredentials
  ? explicitPortalPassword
  : !hasPartialPortalCredentials && reusePanelCredentials
  ? panelPassword
  : undefined;
if (portalUsername && portalPassword) {
  const portal = new ManagementConsoleClient({
    baseUrl: process.env.IGW_PORTAL_BASE_URL || DEFAULT_PORTAL_BASE_URL,
    username: portalUsername,
    password: portalPassword,
  });
  registerManagementConsoleTools(server, portal);
} else if (!hasPartialPortalCredentials) {
  console.error(
    "Portal credentials unavailable; set IGW_PORTAL_USERNAME / IGW_PORTAL_PASSWORD or explicitly enable IGW_PORTAL_USE_PANEL_CREDENTIALS"
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
