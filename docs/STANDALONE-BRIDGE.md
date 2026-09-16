# CJ standalone Shopmonkey bridge

Source: CJVlady/shopmonkey-mcp-server, forked from Gypsumequity/shopmonkey-mcp-server.
Independent of DexDMS. One Railway service, shared by ChatGPT and Claude.

## Hosting

Build: `npm ci && npm run build && npm test`. Start: `node dist/http.js`.
Health path `/health`. Run **one replica** with sleep disabled.
`railway.json` specifies these build/start gates. No real Shopmonkey data is used by tests.

Required environment variables:
- `EXTERNAL_URL`: public HTTPS origin, without trailing slash. MCP client URL is this origin followed by `/`.
- `OAUTH_SIGNING_SECRET`: independent random secret, at least 32 bytes.
- `OAUTH_PASSWORD`: independent owner login password, at least 24 characters. Enter it only on the bridge authorization screen.
- `SHOPMONKEY_API_KEY`: enter directly into Railway Variables; never in chat/git/Linear.
- `MCP_ENABLE_WRITES=false`: default, enforced for discovery and calls. Search endpoints may use HTTP POST but do not mutate provider records.
- Optional `SHOPMONKEY_LOCATION_ID`, `MCP_AUTH_TOKEN` (separate static client credential).

OAuth authorization codes are single-use. Refresh tokens are client-bound and rotate.
Audience is restricted to this bridge. Login has a global 30-attempt/minute limit.
Replay state is process-local: restarting invalidates all access/refresh tokens and outstanding grants, so reconnect clients after deploy/restart. Stable registrations survive restart. Do not scale to multiple replicas without a durable shared grant/revocation store.

## Connect clients

ChatGPT: enable Developer Mode, add custom remote MCP app using the public origin followed by `/`, choose OAuth, then sign in using the bridge password. UI availability depends on account/workspace.
Claude: Customize > Connectors > Add custom connector, same URL; connect and complete OAuth. For organization accounts, an owner may need to add it first.
The password is for the bridge, not the Shopmonkey account. The Shopmonkey key stays server-side.

## Acceptance

1. GET `/health` succeeds (process health only).
2. Unauthenticated MCP POST returns 401 with resource metadata challenge.
3. OAuth discovery, registration, PKCE authorization and token exchange succeed.
4. Authenticated tools/list exposes read tools; create_order is hidden and rejected.
5. Save the real provider key securely; compare a location/vehicle/order read with Shopmonkey UI.
6. Repeat a real read separately in ChatGPT and Claude. Neither a healthy deployment nor mock tests establish live-account acceptance.

Reports cap their datasets; inspect coverage/truncation metadata. Existing write handlers remain available in source but disabled for rollout; their mocked tests are not live write acceptance.
