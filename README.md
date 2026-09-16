> **CJ standalone deployment:** follow [STANDALONE-BRIDGE.md](docs/STANDALONE-BRIDGE.md). It supersedes the older bearer-only deployment instructions below. OAuth variables are required; reads only by default.

# Shopmonkey MCP Server

[![CI](https://github.com/CJVlady/shopmonkey-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/CJVlady/shopmonkey-mcp-server/actions/workflows/ci.yml)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that wraps the [Shopmonkey REST API (v3)](https://shopmonkey.dev/overview), enabling AI agents and LLMs to interact with shop management data — work orders, customers, vehicles, inventory, appointments, payments, labor, canned services, webhooks, and more.

## Features

- **70 source tools** across 12 resource groups covering the Shopmonkey API
- **34 read-only production tools** when `MCP_ENABLE_WRITES=false`
- **Dual transport** — stdio for local/desktop use, Streamable HTTP for cloud deployment
- Shopmonkey API key authentication (Bearer token to Shopmonkey REST API)
- Automatic retry with exponential backoff on rate limits (429) and server errors (5xx)
- Request concurrency control (max 5 simultaneous API calls)
- 30-second request timeout per call
- Multi-location support via `SHOPMONKEY_LOCATION_ID` or per-request `locationId`
- Descriptive error messages surfacing Shopmonkey error codes and messages
- HTTP transport includes bearer auth, health check endpoint, and graceful shutdown
- Works with Claude Desktop, Cursor, Claude Code, Claude.ai, and any MCP-compatible client

## Quick Start

```bash
git clone https://github.com/CJVlady/shopmonkey-mcp-server.git
cd shopmonkey-mcp-server
npm install
npm run build
```

Copy `.env.example` to `.env` and add your Shopmonkey API key:

```bash
cp .env.example .env
# Edit .env — set SHOPMONKEY_API_KEY to your key
```

Start the server:

```bash
# stdio (local use with Claude Desktop, Cursor, Claude Code)
npm start

# HTTP (cloud deployment, Claude.ai)
npm run start:http
```

## Transports

The server ships two entry points sharing a single tool registry — use whichever matches your deployment target.

### stdio (local use)

```bash
node dist/index.js
# or: npm start
```

Your MCP client spawns this process directly. Used by Claude Desktop, Cursor, and Claude Code. See [MCP Client Configuration](#mcp-client-configuration) below.

### Streamable HTTP (cloud deployment)

```bash
PORT=3000 node dist/http.js
# or: npm run start:http
```

The HTTP server listens on `PORT` (default `3000`) and handles MCP requests at `/`. Required for cloud deployment (Railway, Render) and for connecting to Claude.ai.

**HTTP features:**
- **Authentication** — OAuth is always required. `MCP_AUTH_TOKEN` is an optional separate credential for controlled CLI diagnostics.
- **Durable OAuth** — production stores hashed replay state in `OAUTH_STATE_PATH`; tokens remain valid across normal restarts.
- **Health checks** — `GET /health` is liveness and `GET /ready` verifies durable OAuth state.
- **Graceful shutdown** — Clean exit on SIGTERM/SIGINT with a 5-second timeout.

For cloud deployment instructions, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tool Reference

### Work Orders (5 tools)

| Tool | Description |
|------|-------------|
| `list_orders` | List work orders with filters (status, customer, location). Valid statuses: `Estimate`, `RepairOrder`, `Invoice` |
| `get_order` | Get full work order details |
| `create_order` | Create a new work order |
| `update_order` | Update work order fields |
| `add_service_to_order` | Add a service or canned-service template to an order |

> Order deletion is not supported by the Shopmonkey API. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for details.

### Customers (6 tools)

| Tool | Description |
|------|-------------|
| `search_customers` | Search customers by full-body query |
| `search_customers_by_email` | Search for a customer by email address |
| `search_customers_by_phone` | Search for a customer by phone number |
| `get_customer` | Get full customer profile |
| `create_customer` | Create a new customer (name and address fields) |
| `update_customer` | Update customer information |

> Email and phone are sub-resources in Shopmonkey. After creating a customer, use `POST /v3/customer/:id/email` and `/phone_number` to attach contact info. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

### Vehicles (7 tools)

| Tool | Description |
|------|-------------|
| `list_vehicles_for_customer` | List all vehicles for a specific customer |
| `lookup_vehicle_by_vin` | Look up a vehicle by VIN number |
| `lookup_vehicle_by_plate` | Look up a vehicle by license plate and region |
| `list_vehicle_owners` | List owners associated with a vehicle |
| `get_vehicle` | Get full vehicle details |
| `create_vehicle` | Add a vehicle (optionally linked to a customer) |
| `update_vehicle` | Update vehicle data |

### Inventory & Parts (4 tools)

| Tool | Description |
|------|-------------|
| `list_inventory_parts` | List parts inventory |
| `get_inventory_part` | Get single part details |
| `list_inventory_tires` | List tire inventory |
| `search_parts` | Search parts catalog by query |

### Appointments (4 tools)

| Tool | Description |
|------|-------------|
| `list_appointments` | List appointments with date and status filters |
| `get_appointment` | Get full appointment details |
| `create_appointment` | Book a new appointment |
| `update_appointment` | Reschedule or update an appointment |

### Payments (3 tools)

| Tool | Description |
|------|-------------|
| `list_payments` | List payments for an order |
| `get_payment` | Get payment details |
| `create_payment` | Record a payment (`amountCents` — integer cents, e.g., $150.50 = `15050`) |

> All money values use integer cents with `*Cents` naming. Never send decimal dollar amounts.

### Technicians & Labor (5 tools)

| Tool | Description |
|------|-------------|
| `list_labor` | List labor line items |
| `list_timeclock` | Technician clock-in/clock-out events |
| `list_users` | List shop users and technicians |
| `get_user` | Get user/technician profile |
| `assign_technician` | Assign and verify a technician on nested labor lines |

### Services & Canned Services (23 tools)

| Tool | Description |
|------|-------------|
| `list_services` | List services on work orders |
| `list_canned_services` | List pre-built service templates |
| `get_canned_service` | Get canned service details with line items |
| `create_canned_service` | Create a new canned service template |
| `update_canned_service` | Update a canned service |
| `delete_canned_service` | Delete a canned service template |
| `list_customer_deferred_services` | List deferred (recommended but not yet performed) services |

**Canned service line items** — 5 types (fee, labor, part, subcontract, tire) with add/update/remove operations:

| Fee | Labor | Part | Subcontract | Tire |
|-----|-------|------|-------------|------|
| `add_canned_service_fee` | `add_canned_service_labor` | `add_canned_service_part` | `add_canned_service_subcontract` | `add_canned_service_tire` |
| `update_canned_service_fee` | `update_canned_service_labor` | `update_canned_service_part` | `update_canned_service_subcontract` | `update_canned_service_tire` |
| `remove_canned_service_fee` | `remove_canned_service_labor` | `remove_canned_service_part` | `remove_canned_service_subcontract` | `remove_canned_service_tire` |

### Webhooks (5 tools)

| Tool | Description |
|------|-------------|
| `list_webhooks` | List all registered webhooks |
| `get_webhook` | Get webhook details |
| `create_webhook` | Register a new webhook endpoint with trigger types |
| `update_webhook` | Update a webhook |
| `delete_webhook` | Delete a webhook |

**Supported triggers:** `Appointment`, `Customer`, `Inspection`, `Inventory`, `Message`, `Order`, `Payment`, `PurchaseOrder`, `User`, `Vehicle`, `Vendor`

### Reports — Composite (3 tools)

| Tool | Description |
|------|-------------|
| `report_revenue_summary` | Revenue totals by status and paid/unpaid split for a date range |
| `report_appointment_summary` | Appointment counts by confirmation status for a date range |
| `report_open_estimates` | Open unauthorized estimates with age-in-days calculation |

> Composite reports scan at most 1,000 provider records and report when results are truncated.

### Workflow & Locations (2 tools)

| Tool | Description |
|------|-------------|
| `list_workflow_statuses` | Get pipeline/workflow stages |
| `list_locations` | List shop locations |

## MCP Client Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shopmonkey": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/shopmonkey-mcp-server",
      "env": {
        "SHOPMONKEY_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "shopmonkey": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/shopmonkey-mcp-server",
      "env": {
        "SHOPMONKEY_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add shopmonkey -e SHOPMONKEY_API_KEY=your_api_key_here -- node /path/to/shopmonkey-mcp-server/dist/index.js
```

### Claude.ai (HTTP transport)

Deploy `dist/http.js` with the required OAuth variables and durable `OAUTH_STATE_PATH`. Connect through the OAuth flow; the Shopmonkey API key stays server-side. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, dual transport, tool module pattern, client resilience |
| [Capabilities](docs/CAPABILITIES.md) | All 70 tools with use-case descriptions |
| [Changelog](CHANGELOG.md) | Release history |
| [Credits](CREDITS.md) | Fork authors whose field reports drive this project |
| [API Provenance](docs/API-PROVENANCE.md) | Why v1.0.0 called endpoints that do not exist |
| [Limitations](docs/LIMITATIONS.md) | Unsupported operations with rationale and workarounds |
| [Deployment](docs/DEPLOYMENT.md) | Railway + Doppler single-tenant deployment guide |
| [Multi-Tenant Future](docs/MULTI-TENANT-FUTURE.md) | Future-work exploration for multi-shop deployment |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SHOPMONKEY_API_KEY` | Yes | — | Shopmonkey API key (Settings > Integration > API Keys) |
| `SHOPMONKEY_BASE_URL` | No | `https://api.shopmonkey.cloud/v3` | API base URL |
| `SHOPMONKEY_LOCATION_ID` | No | — | Scope all queries to one location (multi-location shops) |
| `EXTERNAL_URL` | HTTP: Yes | — | Exact public HTTPS origin used as the OAuth issuer and audience |
| `OAUTH_SIGNING_SECRET` | HTTP: Yes | — | Independent signing secret, at least 32 bytes |
| `OAUTH_PASSWORD` | HTTP: Yes | — | Owner authorization password, at least 24 characters |
| `OAUTH_STATE_PATH` | Production HTTP: Yes | — | SQLite path on persistent storage; `/data/oauth-state.sqlite` on Railway |
| `MCP_AUTH_TOKEN` | No | — | Optional separate bearer credential for controlled diagnostics |
| `MCP_ENABLE_WRITES` | No | `false` | Set to `true` only after separate write acceptance |
| `NODE_ENV` | Production HTTP: Yes | — | Must be `production` on Railway |
| `PORT` | No | `3000` | HTTP transport listening port |

The server automatically loads `.env` via [dotenv](https://www.npmjs.com/package/dotenv) if present. You can also pass variables through your shell or MCP client config.

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Watch mode (tsc --watch)
npm start            # Start stdio server
npm run start:http   # Start HTTP server
npm test             # Run test suite (requires build first)
```

The test suite covers API mappings, MCP protocol behavior, OAuth security and restart persistence, HTTP hardening, error paths and transport validation.

## Error Handling

The server handles common API scenarios:

- **Missing API key** — Descriptive error with setup instructions
- **Rate limiting (429)** — Automatic retry with exponential backoff (up to 3 attempts), respects `Retry-After` header
- **Server errors (500, 502, 503, 504)** — Automatic retry with backoff
- **Request timeout** — 30-second abort with clear error message
- **Network failures** — Retry with backoff, readable error messages
- **API errors** — Surfaces Shopmonkey error codes (`API-xxxxx`, `ORM-xxxxx`) and human-readable `message` field

## API Reference

- [Shopmonkey API Documentation](https://shopmonkey.dev/overview)
- [Shopmonkey API Base URL](https://api.shopmonkey.cloud/v3)
- [Model Context Protocol](https://modelcontextprotocol.io)

## License

[MIT](LICENSE)
