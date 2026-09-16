# Private standalone Shopmonkey bridge

Source: `CJVlady/shopmonkey-mcp-server`. The bridge is independent of DexDMS and runs as one private Railway service for approved Northwest Motors clients.

## Production contract

- Runtime: Node.js 24.
- Build: `npm ci && npm run build && npm test && npm audit --omit=dev --audit-level=high`.
- Start: `npm run start:http`.
- Liveness: `GET /health`.
- Readiness: `GET /ready`; Railway uses this path.
- MCP endpoint: the public HTTPS origin followed by `/`.
- Scale: exactly one replica.
- Registry: do not publish the live URL to HAPI or the official MCP Registry.

## Required configuration

Mount one persistent Railway volume at `/data`, then set:

```text
NODE_ENV=production
OAUTH_STATE_PATH=/data/oauth-state.sqlite
MCP_ENABLE_WRITES=false
```

Also set `EXTERNAL_URL`, `OAUTH_SIGNING_SECRET`, `OAUTH_PASSWORD`, and `SHOPMONKEY_API_KEY` directly in the approved secret store. Never place their values in GitHub, chat, Drive, Linear, logs or test fixtures. `MCP_AUTH_TOKEN` is optional and must be independent from every other credential.

## OAuth behavior

- OAuth is always required for remote MCP requests.
- Authorization Code with PKCE S256, exact redirect matching and resource audience checks are enforced.
- Authorization codes are single-use. Refresh tokens rotate and cannot be replayed.
- Durable state stores only SHA-256 token hashes, token kind and expiry.
- Valid access tokens and replay denial survive normal restarts while the signing secret and `/data` volume remain intact.
- A missing or unhealthy state database prevents production startup or readiness.

## Safety boundary

The source contains 70 tools. With `MCP_ENABLE_WRITES=false`, the remote server exposes 34 read-only tools and rejects hidden write calls. Search tools may use HTTP POST against Shopmonkey search endpoints without mutating provider records.

## Client acceptance

Each client must independently complete OAuth and a real bounded read. A Railway health response, local tests, another client's success or a visible connector does not prove live client acceptance.

ChatGPT and Claude therefore require separate receipts. Do not mark Claude verified from a ChatGPT test.

## Deployment acceptance

1. `/health` and `/ready` return HTTP 200.
2. An unauthenticated MCP POST returns HTTP 401 with protected-resource metadata.
3. OAuth discovery, registration, PKCE authorization and token exchange succeed.
4. Authenticated `tools/list` exposes read tools and excludes `create_order`.
5. A valid access token still works after a controlled restart and a consumed grant remains rejected.
6. Bounded Shopmonkey reads match the intended live account; no write is performed.
7. HAPI searches for the project return no public entry.

## Rollback

Record the exact prior Railway deployment before release. Back up `/data/oauth-state.sqlite` before any future schema change. A rollback to v1 invalidates existing OAuth sessions after restart, so reconnect affected clients. Never delete the volume during an application rollback.
