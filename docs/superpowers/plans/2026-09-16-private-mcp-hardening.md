# Private Shopmonkey MCP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the private Northwest Motors Shopmonkey MCP so OAuth survives normal deployments, replay protection is durable, HTTP behavior is production-safe, and releases are reproducible.

**Architecture:** A focused `OAuthStateStore` owns durable one-time-token consumption in a SQLite file mounted on Railway. The existing OAuth router keeps signing and protocol responsibilities, while the HTTP entry point owns liveness, readiness, security headers, rate limits and redacted request logs. The service remains private, read-only and single-replica.

**Tech Stack:** Node.js 24, TypeScript 5.9, Node built-in `node:sqlite`, MCP TypeScript SDK, Node test runner, Railway.

**Spec:** `docs/superpowers/specs/2026-09-16-private-mcp-hardening-design.md`

## Global Constraints

- The live Railway URL must not be published to HAPI or the official MCP Registry.
- Production must keep `MCP_ENABLE_WRITES=false`.
- No raw credentials, tokens, OAuth payloads, Shopmonkey payloads or customer data may be persisted or logged.
- Production requires `OAUTH_STATE_PATH=/data/oauth-state.sqlite` on a Railway persistent volume.
- The service remains single-replica.
- Every behavior change must follow red-green-refactor TDD.
- Node.js 24 is the only supported runtime for release, CI and Railway.

---

### Task 1: Durable OAuth replay store

**Files:**
- Create: `src/oauth-state.ts`
- Create: `src/tests/oauth-state.test.ts`

**Interfaces:**
- Produces: `class OAuthStateStore` with `constructor(path: string)`, `consume(token: string, kind: 'code' | 'refresh', expiry: number): boolean`, `ready(): boolean`, `prune(now?: number): number`, and `close(): void`.
- Persists: table `consumed_tokens(token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL)`.

- [ ] **Step 1: Write failing tests for atomic consume, hashing, pruning and reopen persistence**

```ts
test('consumed tokens remain blocked after reopening the database', () => {
  const path = join(tmp, 'oauth.sqlite');
  const first = new OAuthStateStore(path);
  assert.equal(first.consume('raw-code', 'code', now + 60), true);
  first.close();
  const second = new OAuthStateStore(path);
  assert.equal(second.consume('raw-code', 'code', now + 60), false);
  const rows = second.inspectForTest();
  assert.equal(rows[0].token_hash, createHash('sha256').update('raw-code').digest('hex'));
  assert.ok(!JSON.stringify(rows).includes('raw-code'));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node --test dist/tests/oauth-state.test.js`
Expected: compilation fails because `../oauth-state.js` does not exist.

- [ ] **Step 3: Implement the minimal SQLite store**

```ts
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class OAuthStateStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS consumed_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN (\'code\',\'refresh\')), expires_at INTEGER NOT NULL)');
  }
  consume(token: string, kind: 'code' | 'refresh', expiry: number): boolean {
    this.prune();
    const hash = createHash('sha256').update(token).digest('hex');
    return this.db.prepare('INSERT OR IGNORE INTO consumed_tokens(token_hash, kind, expires_at) VALUES (?, ?, ?)').run(hash, kind, expiry).changes === 1;
  }
  ready(): boolean { return this.db.prepare('SELECT 1 AS ok').get() !== undefined; }
  prune(now = Math.floor(Date.now() / 1000)): number { return Number(this.db.prepare('DELETE FROM consumed_tokens WHERE expires_at <= ?').run(now).changes); }
  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm run build && node --test dist/tests/oauth-state.test.js && npm test`
Expected: all OAuth state tests and the existing 385 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/oauth-state.ts src/tests/oauth-state.test.ts
git commit -m "feat: persist OAuth replay state"
```

### Task 2: Restart-safe OAuth tokens and fail-closed configuration

**Files:**
- Modify: `src/oauth.ts`
- Modify: `src/http.ts`
- Modify: `src/tests/oauth-security.test.ts`
- Create: `src/tests/oauth-restart.test.ts`

**Interfaces:**
- `configureOAuthState(path: string): OAuthStateStore` initializes the shared store before HTTP listen.
- `oauthReady(): boolean` is used by `/ready`.
- `closeOAuthState(): void` closes SQLite during shutdown.
- Access tokens remain HMAC-signed, audience-bound and expiring; they no longer include a process boot identifier.

- [ ] **Step 1: Write a restart regression test**

```ts
test('access and replay state survive a server restart', async () => {
  const statePath = join(tmp, 'oauth.sqlite');
  const first = await startServer(statePath);
  const issued = await authorizeAndExchange(first.base);
  await first.stop();
  const second = await startServer(statePath);
  assert.equal((await listTools(second.base, issued.access_token)).status, 200);
  assert.equal((await exchange(second.base, issued.code)).status, 400);
  await second.stop();
});
```

- [ ] **Step 2: Write startup tests for missing or unwritable production state**

```ts
test('production refuses to start without OAUTH_STATE_PATH', async () => {
  const child = spawnServer({ NODE_ENV: 'production', OAUTH_STATE_PATH: '' });
  assert.match(await stderrUntilExit(child), /OAUTH_STATE_PATH is required/);
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm run build && node --test dist/tests/oauth-restart.test.js`
Expected: access token becomes invalid after restart and missing state configuration does not fail closed.

- [ ] **Step 4: Inject `OAuthStateStore`, remove `BOOT_ID`, and close state on shutdown**

Use `store.consume(rawToken, 'code', code.exp)` and `store.consume(rawToken, 'refresh', rt.exp)`. Validate the database during startup before calling `httpServer.listen`. Keep test and development default state at `:memory:`; require an explicit path when `NODE_ENV=production`.

- [ ] **Step 5: Run focused and full tests**

Run: `npm run build && node --test dist/tests/oauth-security.test.js dist/tests/oauth-restart.test.js && npm test`
Expected: restart behavior passes and all earlier OAuth protections remain green.

- [ ] **Step 6: Commit**

```bash
git add src/oauth.ts src/http.ts src/tests/oauth-security.test.ts src/tests/oauth-restart.test.ts
git commit -m "feat: keep OAuth valid across deployments"
```

### Task 3: HTTP readiness, response hardening, bounded rate limits and safe logs

**Files:**
- Create: `src/http-security.ts`
- Create: `src/tests/http-security.test.ts`
- Modify: `src/http.ts`
- Modify: `src/oauth.ts`
- Modify: `src/tests/http-transport.test.ts`

**Interfaces:**
- `securityHeaders(contentType?: 'html' | 'json'): Record<string, string>` returns common headers and CSP for HTML.
- `class SlidingWindowLimiter` exposes `allow(key: string, now?: number): { allowed: boolean; retryAfter: number }`.
- `requestLog(req, status, startedAt, requestId)` returns one JSON-safe line containing only request ID, method, pathname, status and duration.

- [ ] **Step 1: Write failing tests for headers and `/ready`**

```ts
it('returns hardened headers without exposing details', async () => {
  const response = await fetch(base + '/ready');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
```

- [ ] **Step 2: Write failing unit tests for bounded limiter eviction and endpoint isolation**

```ts
test('limiter rejects only after the configured budget', () => {
  const limiter = new SlidingWindowLimiter(2, 60_000, 100);
  assert.equal(limiter.allow('register:127.0.0.1', 0).allowed, true);
  assert.equal(limiter.allow('register:127.0.0.1', 1).allowed, true);
  assert.equal(limiter.allow('register:127.0.0.1', 2).allowed, false);
});
```

- [ ] **Step 3: Write a failing log-redaction test**

Capture stderr for requests containing `Authorization`, `password`, OAuth `code`, and a query string. Assert parsed log records contain only `requestId`, `method`, `path`, `status`, and `durationMs`, and contain none of the supplied secret values.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `npm run build && node --test dist/tests/http-security.test.js dist/tests/http-transport.test.js`
Expected: missing module, `/ready`, headers and structured log assertions fail.

- [ ] **Step 5: Implement minimal security helpers and integrate them**

Apply response headers through the JSON/HTML helpers and the HTTP server response path. Derive limiter keys from `req.socket.remoteAddress`, not proxy-controlled headers. Limit `/register`, POST `/authorize` and `/token` separately. Emit one redacted JSON completion record per request.

- [ ] **Step 6: Run focused and full tests**

Run: `npm run build && node --test dist/tests/http-security.test.js dist/tests/http-transport.test.js dist/tests/oauth-security.test.js && npm test`
Expected: security tests and the complete suite pass.

- [ ] **Step 7: Commit**

```bash
git add src/http-security.ts src/http.ts src/oauth.ts src/tests/http-security.test.ts src/tests/http-transport.test.ts src/tests/oauth-security.test.ts
git commit -m "feat: harden private HTTP transport"
```

### Task 4: Release identity, CI and private deployment documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/STANDALONE-BRIDGE.md`
- Modify: `CHANGELOG.md`
- Modify: `railway.json`
- Create: `docs/PRIVATE-REGISTRY-POLICY.md`

**Interfaces:**
- Package version: `2.0.0`.
- Runtime: `node >=24 <25` everywhere.
- Production configuration: `NODE_ENV=production`, `OAUTH_STATE_PATH=/data/oauth-state.sqlite`, Railway volume mounted at `/data`, `MCP_ENABLE_WRITES=false`.

- [ ] **Step 1: Write a failing metadata test**

Add assertions to `src/tests/mcp-protocol.test.ts` that package repository, bugs and homepage point to `CJVlady/shopmonkey-mcp-server`, version is `2.0.0`, engine is `>=24 <25`, and README states 70 total source tools and 34 read-only production tools.

- [ ] **Step 2: Run the metadata test and verify RED**

Run: `npm run build && node --test dist/tests/mcp-protocol.test.js`
Expected: current version, repository and README assertions fail.

- [ ] **Step 3: Correct package and CI metadata**

Set repository to `https://github.com/CJVlady/shopmonkey-mcp-server.git`, bugs to the matching issues URL, homepage to the matching README URL, author to `CJVlady and contributors`, version to `2.0.0`, and CI Node to `24`. Run `npm install --package-lock-only` to update the lockfile.

- [ ] **Step 4: Add release gates**

CI commands must run `npm ci`, `npm run build`, `npm test`, `npm audit --omit=dev --audit-level=high`, and `npm pack --dry-run`.

- [ ] **Step 5: Replace obsolete deployment instructions**

Document OAuth variables, `/data` volume, readiness, rollback, private-registry policy, 70 source tools, 34 read-only tools, no open-access mode, and separate ChatGPT/Claude acceptance receipts. Set Railway health path to `/ready` so readiness includes SQLite.

- [ ] **Step 6: Run metadata, documentation and full gates**

Run: `npm install --package-lock-only && npm run build && npm test && npm audit --omit=dev --audit-level=high && npm pack --dry-run`
Expected: exit 0, all tests pass, audit reports zero high/critical production vulnerabilities, and package contents contain no secrets or state databases.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .github/workflows/ci.yml .env.example README.md docs/DEPLOYMENT.md docs/STANDALONE-BRIDGE.md docs/PRIVATE-REGISTRY-POLICY.md CHANGELOG.md railway.json src/tests/mcp-protocol.test.ts
git commit -m "release: prepare private bridge v2"
```

### Task 5: Review, merge, deploy and live acceptance

**Files:**
- Verify: all changed files
- Update after verified deployment: canonical NOVA Drive document and existing Linear NW-57 comment

**Interfaces:**
- Railway volume mount: `/data`.
- Railway variable: `OAUTH_STATE_PATH=/data/oauth-state.sqlite`.
- Release acceptance uses the exact merged commit and Railway deployment ID.

- [ ] **Step 1: Perform implementation self-review**

Run: `git diff master...HEAD --check && git diff --stat master...HEAD && git status --short`
Expected: no whitespace errors, only planned files changed, clean worktree.

- [ ] **Step 2: Run the final local verification gate fresh**

Run: `npm ci && npm run build && npm test && npm audit --omit=dev --audit-level=high && npm pack --dry-run`
Expected: every command exits 0 and test output reports zero failures.

- [ ] **Step 3: Merge the verified branch and push**

Fast-forward `master` to `codex/harden-private-mcp`, then push `master` to `origin`. Do not force-push.

- [ ] **Step 4: Provision durable Railway state before the v2 deployment**

Mount one Railway persistent volume at `/data`; set `NODE_ENV=production` and `OAUTH_STATE_PATH=/data/oauth-state.sqlite`; retain one replica and `MCP_ENABLE_WRITES=false`. Read back the saved configuration without printing secret values.

- [ ] **Step 5: Verify deployment and controlled restart behavior**

Check `/health`, `/ready`, OAuth discovery, unauthenticated 401 challenge and authenticated tool discovery. Obtain an access token, restart or redeploy the same commit, and prove the token still lists read tools while a consumed authorization code remains rejected.

- [ ] **Step 6: Run bounded live Shopmonkey reads**

Repeat the established live read-only acceptance matrix. Record exact pass/fail counts; do not create a webhook or enable writes solely to complete a test.

- [ ] **Step 7: Verify clients and record remaining external gate**

Reconnect ChatGPT only if required and complete one real bounded read. Claude remains explicitly unverified until its own UI authorization and read are completed by that client.

- [ ] **Step 8: Verify HAPI privacy and sync NOVA**

Search HAPI for `shopmonkey`, `shopmonkey-mcp-server` and `CJVlady`; expect zero results. Update the canonical NOVA document and existing NW-57 comment with the exact commit, deployment, test count, live-read count, write-disabled state and remaining Claude gate; independently read back both writes.
