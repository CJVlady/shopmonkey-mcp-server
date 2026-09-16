# Private Shopmonkey MCP hardening design

Date: September 16, 2026

## Goal

Make the existing standalone Shopmonkey MCP bridge a reliable, private production service for Northwest Motors. Preserve the verified read-only behavior, keep the live Railway endpoint out of public MCP registries, and remove the operational gaps that force reconnects or weaken release confidence.

## Scope

This change covers the `CJVlady/shopmonkey-mcp-server` repository and its existing single-service Railway deployment. It does not add Shopmonkey writes, change Shopmonkey business records, merge the bridge into DexDMS, publish a public registry entry, or claim acceptance in a client that has not completed its own live test.

## Production boundary

- The live Railway URL remains private operational configuration and is not published to HAPI or the official MCP Registry.
- OAuth remains mandatory for remote MCP requests. `MCP_AUTH_TOKEN` remains an optional separate credential for controlled diagnostics.
- `MCP_ENABLE_WRITES=false` remains the production default. Write tools stay hidden and rejected.
- The service remains single-replica until its durable state layer is explicitly designed for shared multi-replica use.

## Durable OAuth state

Replace process-local replay state and boot-bound access tokens with a durable SQLite state store on a Railway persistent volume.

- Add `OAUTH_STATE_PATH`, set in production to `/data/oauth-state.sqlite`.
- Store only SHA-256 token hashes, token kind and expiry. Do not store raw authorization codes, access tokens, refresh tokens, passwords or Shopmonkey keys.
- Consume authorization codes and rotated refresh tokens atomically with a unique hash constraint. Delete expired rows during bounded maintenance.
- Signed access tokens remain audience-bound and time-limited, but no longer depend on a random process boot identifier. A valid token therefore survives a normal deployment while its signing secret and database remain unchanged.
- Production startup fails closed when the durable state path is missing, unwritable or unhealthy. Tests use isolated temporary databases.
- A restart regression test obtains a token, restarts the server with the same secret and database, verifies the access token still works, and verifies a consumed grant cannot be replayed.

## HTTP and authorization hardening

- Add consistent `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame denial and a restrictive authorization-page content security policy.
- Keep OAuth PKCE S256, exact redirect matching, resource audience checks, rotating refresh tokens and bounded request bodies.
- Add bounded per-address rate limits for registration, authorization and token endpoints without logging request bodies or credentials.
- Add `/ready` to verify configuration and the durable OAuth store. Keep `/health` as a process liveness check.
- Emit structured, redacted request logs containing request ID, method, path, status and duration. Never log query strings, authorization headers, OAuth payloads, Shopmonkey payloads or customer data.
- Return generic client errors while retaining safe server-side diagnostic codes.

## Release and repository correctness

- Bump the bridge to version `2.0.0` because production OAuth persistence and configuration requirements change.
- Correct repository, bugs, homepage and author metadata to the `CJVlady` fork while preserving upstream credit and license records.
- Align local engines, CI and deployment documentation on Node 24.
- Correct tool counts and remove obsolete bearer-only/open-access instructions.
- Document the persistent volume, backup/restore expectations, rollback steps and the intentional absence from public registries.
- Add CI gates for clean install, build, all tests, production dependency audit and package dry run.

## Test strategy

All behavior changes follow red-green-refactor TDD.

1. Add failing persistence tests for access-token survival and replay denial across restart.
2. Add failing tests for missing/unwritable production state, readiness and security headers.
3. Add failing tests for bounded OAuth endpoint rate limiting and redacted structured logs.
4. Implement the minimum code required for each failing test.
5. Run the complete build and test suite, production dependency audit and package dry run.
6. Deploy only from the verified commit, then check `/health`, `/ready`, unauthenticated OAuth challenge, discovery metadata and an authenticated ChatGPT read.
7. Record Claude as unverified until Claude independently authorizes and completes a live bounded read.

## Deployment and rollback

- Provision a Railway volume mounted at `/data` before deploying code that requires `OAUTH_STATE_PATH=/data/oauth-state.sqlite`.
- Back up or copy the SQLite file before a rollback that changes its schema.
- Keep migrations additive and idempotent.
- Rollback restores the prior Railway deployment and prior environment. The earlier build invalidates tokens after restart, so affected clients must reconnect after that rollback.
- Never expose secrets in GitHub, Linear, Drive, logs or test fixtures.

## Acceptance

The private bridge is accepted when:

- clean install, TypeScript build, all tests, production dependency audit and package dry run pass on Node 24;
- a deployment preserves OAuth access and replay protection through a controlled restart;
- `/health` and `/ready` return HTTP 200;
- unauthenticated MCP requests return the correct protected-resource challenge;
- authenticated discovery exposes only read tools while writes are disabled;
- the prior 33 live Shopmonkey reads still succeed and webhook behavior remains accurately reported;
- ChatGPT completes a fresh bounded read after deployment;
- documentation and NOVA/Linear receipts identify the exact commit and deployment;
- the HAPI registry continues to return no public entry for this private server.

Claude acceptance is a separate client gate. It may remain open without weakening the verified ChatGPT production receipt, but the overall two-client goal is not complete until Claude passes.
