# Private Railway deployment

This deployment is single-tenant and private. It is not a public hosted Shopmonkey service.

## Prerequisites

- Node.js 24 for local verification.
- The existing Railway project and GitHub repository.
- A Shopmonkey API key entered only in Railway Variables or an approved secret manager.
- One persistent Railway volume.

## Build and start

`railway.json` is authoritative:

- Build: `npm ci && npm run build && npm test`
- Start: `npm run start:http`
- Readiness check: `/ready`
- Restart policy: on failure, at most three retries

CI additionally runs a production dependency audit and package dry run.

## Persistent OAuth state

Create one volume and mount it at `/data`. Do this before deploying v2. Set:

```text
NODE_ENV=production
OAUTH_STATE_PATH=/data/oauth-state.sqlite
```

The database contains only SHA-256 hashes of consumed authorization codes and refresh tokens, their kind and expiry. Keep one service replica; SQLite is not the shared state layer for a multi-replica deployment.

## Required variables

| Variable | Requirement |
|---|---|
| `SHOPMONKEY_API_KEY` | Required; secret |
| `EXTERNAL_URL` | Required; exact public HTTPS origin, no trailing slash |
| `OAUTH_SIGNING_SECRET` | Required; independent secret of at least 32 bytes |
| `OAUTH_PASSWORD` | Required; independent owner password of at least 24 characters |
| `OAUTH_STATE_PATH` | Required; `/data/oauth-state.sqlite` |
| `NODE_ENV` | Required; `production` |
| `MCP_ENABLE_WRITES` | Required for this rollout; `false` |
| `SHOPMONKEY_LOCATION_ID` | Optional location scope |
| `MCP_AUTH_TOKEN` | Optional independent CLI/diagnostic credential |

Do not print secret values while verifying configuration.

## Verification

```bash
BRIDGE_ORIGIN="https://your-service.up.railway.app"
curl --fail --silent --show-error "$BRIDGE_ORIGIN/health"
curl --fail --silent --show-error "$BRIDGE_ORIGIN/ready"
curl --silent --show-error --dump-header - --output /dev/null \
  --request POST --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$BRIDGE_ORIGIN/"
```

Expected results are `{"status":"ok"}`, `{"status":"ready"}`, and HTTP 401 with a `WWW-Authenticate` protected-resource pointer.

Complete the OAuth flow in each approved client. With writes disabled, `tools/list` exposes 34 read-only tools and omits write tools. Run a bounded provider read and compare its account/location identity to Shopmonkey.

## Controlled restart test

Before restart, obtain a client token and consume one authorization code. Restart the same deployed commit without changing `OAUTH_SIGNING_SECRET` or the volume. After restart:

- the access token must still list tools;
- the consumed authorization code must remain rejected;
- `/ready` must return HTTP 200.

## Logs

The service writes one redacted JSON completion record per HTTP request containing request ID, method, pathname, status and duration. Query strings, headers, bodies, OAuth material, Shopmonkey payloads and customer data are excluded.

## Rollback

1. Record the current and prior deployment IDs.
2. Back up the SQLite file before any future schema migration.
3. Restore the prior application deployment without deleting the volume.
4. If rolling back to v1, reconnect clients because v1 intentionally invalidates tokens on restart.

## Registry policy

The Railway URL is private infrastructure. Do not create `server.json`, set an npm `mcpName`, or publish this deployment to HAPI or the official MCP Registry. See [PRIVATE-REGISTRY-POLICY.md](PRIVATE-REGISTRY-POLICY.md).
