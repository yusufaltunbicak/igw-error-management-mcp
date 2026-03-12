# InsurGateway Error Management MCP Server

[![npm version](https://img.shields.io/npm/v/igw-error-management-mcp.svg)](https://www.npmjs.com/package/igw-error-management-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for tracking, analyzing, and reporting errors from [InsurGateway](https://insurgateway.com/).

## Features

- **Error Tracking** — List, filter, and search errors by date, branch, product, company, and status
- **Error Logs** — View detailed request/response logs for each error
- **Error Analysis** — Get analysis details with possible causes and suggestions
- **Error Actions** — Pin errors, send error reports, and file bug reports
- **Lookups** — Search products and list insurance companies for filtering

## Setup (3 steps)

### Step 1 — Add your IGW credentials to your shell profile

Open `~/.zshrc` (macOS) or `~/.bashrc` (Linux) and add:

```bash
# InsurGateway MCP — choose your environment:
# Test:       https://testgatewayapi.insurapps.net/api
# Production: https://gatewayapi.insurapps.net/api
export IGW_BASE_URL="https://testgatewayapi.insurapps.net/api"

export IGW_USERNAME="your-username"
export IGW_PASSWORD="your-password"
export IGW_WEB_API_KEY="your-api-key"
```

Then reload your shell:

```bash
source ~/.zshrc
```

### Step 2 — Add the MCP server to your project

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "igw-error-management": {
      "command": "npx",
      "args": ["-y", "igw-error-management-mcp@latest"],
      "env": {
        "IGW_BASE_URL": "${IGW_BASE_URL}",
        "IGW_USERNAME": "${IGW_USERNAME}",
        "IGW_PASSWORD": "${IGW_PASSWORD}",
        "IGW_WEB_API_KEY": "${IGW_WEB_API_KEY}"
      }
    }
  }
}
```

> **Note:** If your project already has `.mcp.json`, just add the `"igw-error-management"` entry inside `"mcpServers"`.

### Step 3 — Restart Claude Code

Restart Claude Code (or Claude Desktop) and the IGW tools will be available automatically.

That's it! Try asking: *"Son 24 saatte hangi hatalari var?"*

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "igw-error-management": {
      "command": "npx",
      "args": ["-y", "igw-error-management-mcp"],
      "env": {
        "IGW_BASE_URL": "https://testgatewayapi.insurapps.net/api",
        "IGW_USERNAME": "your-username",
        "IGW_PASSWORD": "your-password",
        "IGW_WEB_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `IGW_BASE_URL` | InsurGateway API base URL (see below) | `https://api.insurgateway.com/api` |
| `IGW_USERNAME` | IGW account username | *required* |
| `IGW_PASSWORD` | IGW account password | *required* |
| `IGW_WEB_API_KEY` | IGW Web API key | *required* |

### Available Environments

| Environment | URL |
|-------------|-----|
| Test | `https://testgatewayapi.insurapps.net/api` |
| Production | `https://gatewayapi.insurapps.net/api` |

> **Tip:** Switch environments anytime by changing `IGW_BASE_URL` and restarting Claude Code.

## Tools

### Error Queries (read-only)

| Tool | Description |
|------|-------------|
| `igw_errors_list` | List errors with filters (date range, branch, product, company, status flags) |
| `igw_errors_operations` | Get error operations — which service operations produce errors |
| `igw_errors_logs` | Get detailed error log entries |
| `igw_errors_log_detail` | Get full request/response data for a specific error log |
| `igw_errors_analyze` | Analyze a specific error — possible causes and suggestions |

### Error Actions (write)

| Tool | Description |
|------|-------------|
| `igw_errors_pin` | Pin/unpin an error for tracking |
| `igw_errors_send_report` | Send an error report with description to the relevant team |
| `igw_errors_send_bug_report` | Send a bug report by reference number to InsurGateway |

### Lookups (read-only)

| Tool | Description |
|------|-------------|
| `igw_products_search` | Search products by name — get product IDs for error filters |
| `igw_insurance_companies` | List available insurance companies — get company IDs for error filters |

## Alternative Installation

### Global install

```bash
npm install -g igw-error-management-mcp
```

### From source

```bash
git clone https://github.com/yusufaltunbicak/igw-error-management-mcp.git
cd igw-error-management-mcp
npm install
npm run build
npm start
```

## License

MIT
