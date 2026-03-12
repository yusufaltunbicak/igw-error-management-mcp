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

## Installation

### Via npx (recommended)

```bash
npx igw-error-management-mcp
```

### Global Installation

```bash
npm install -g igw-error-management-mcp
```

### From Source

```bash
git clone https://github.com/yusufaltunbicak/igw-error-management-mcp.git
cd igw-error-management-mcp
npm install
npm run build
```

## Configuration

Set environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `IGW_BASE_URL` | InsurGateway API base URL | `https://api.insurgateway.com/api` |
| `IGW_USERNAME` | IGW account username | *required* |
| `IGW_PASSWORD` | IGW account password | *required* |
| `IGW_WEB_API_KEY` | IGW Web API key | *required* |

## Quick Start

### Claude Code

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

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "igw-error-management": {
      "command": "npx",
      "args": ["-y", "igw-error-management-mcp"],
      "env": {
        "IGW_BASE_URL": "https://api.insurgateway.com/api",
        "IGW_USERNAME": "your-username",
        "IGW_PASSWORD": "your-password",
        "IGW_WEB_API_KEY": "your-api-key"
      }
    }
  }
}
```

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

## License

MIT
