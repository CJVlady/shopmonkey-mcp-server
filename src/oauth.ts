/**
 * Stateless OAuth 2.1 authorization server for the Shopmonkey MCP HTTP transport.
 *
 * Implements the subset of RFC 6749 / 7591 / 7636 / 8414 / 8707 and the MCP
 * authorization spec that Claude's custom-connector client exercises:
 *
 *   GET  /.well-known/oauth-protected-resource   resource metadata (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server AS metadata (RFC 8414)
 *   POST /register                               dynamic client registration (RFC 7591)
 *   GET  /authorize                              login form
 *   POST /authorize                              password check -> authorization code
 *   POST /token                                  code -> access token, refresh
 *
 * Clients and tokens are signed. A durable replay ledger tracks consumed grants,
 * so valid credentials and replay denial survive process restarts.
 *
 * Dependencies: node builtins only.
 */
import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuthStateStore, type ConsumableTokenKind } from './oauth-state.js';
import { securityHeaders, SlidingWindowLimiter } from './http-security.js';

const SECRET = process.env.OAUTH_SIGNING_SECRET ?? '';
const PASSWORD = process.env.OAUTH_PASSWORD ?? '';
const EXTERNAL_URL = (process.env.EXTERNAL_URL ?? '').replace(/\/+$/, '');
const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL ?? 3600);
const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL ?? 2592000);
const CODE_TTL = 60;
let stateStore: OAuthStateStore | null = null;
const endpointLimiters = {
  register: new SlidingWindowLimiter(30, 60_000, 10_000),
  authorize: new SlidingWindowLimiter(30, 60_000, 10_000),
  token: new SlidingWindowLimiter(60, 60_000, 10_000),
};

export function initializeOAuthState(): void {
  if (stateStore) return;
  const configuredPath = process.env.OAUTH_STATE_PATH?.trim();
  if (process.env.NODE_ENV === 'production' && !configuredPath) {
    throw new Error('OAUTH_STATE_PATH is required in production');
  }
  stateStore = new OAuthStateStore(configuredPath || ':memory:');
}

export function oauthReady(): boolean {
  try {
    return stateStore?.ready() === true;
  } catch {
    return false;
  }
}

export function closeOAuthState(): void {
  stateStore?.close();
  stateStore = null;
}

function consume(token: string, kind: ConsumableTokenKind, expiry: number): boolean {
  if (!stateStore) throw new Error('OAuth state store is not initialized');
  return stateStore.consume(token, kind, expiry);
}

export function oauthConfigError(): string | null {
  if (!SECRET) return 'OAUTH_SIGNING_SECRET is not set';
  if (Buffer.from(SECRET, 'utf8').length < 32) return 'OAUTH_SIGNING_SECRET must be at least 32 bytes';
  if (PASSWORD.length < 24) return 'OAUTH_PASSWORD must contain at least 24 characters';
  if (!EXTERNAL_URL.startsWith('https://') && !EXTERNAL_URL.startsWith('http://localhost')) {
    return 'EXTERNAL_URL must be set to the public https:// URL of this server';
  }
  if (!Number.isSafeInteger(ACCESS_TTL) || ACCESS_TTL <= 0) {
    return 'ACCESS_TOKEN_TTL must be a positive integer';
  }
  if (!Number.isSafeInteger(REFRESH_TTL) || REFRESH_TTL <= 0) {
    return 'REFRESH_TOKEN_TTL must be a positive integer';
  }
  if (process.env.NODE_ENV === 'production' && !process.env.OAUTH_STATE_PATH?.trim()) {
    return 'OAUTH_STATE_PATH is required in production';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* signing primitives                                                  */
/* ------------------------------------------------------------------ */

const b64u = (b: Buffer): string => b.toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function sign(payload: Record<string, unknown>): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64u(createHmac('sha256', SECRET).update(body).digest());
  return `${body}.${mac}`;
}

function verify<T = Record<string, unknown>>(token: string): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64u(createHmac('sha256', SECRET).update(body).digest());
  // constant-time compare; lengths must match first or timingSafeEqual throws
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(unb64u(body).toString('utf8')) as Record<string, unknown>;
    if (parsed.t && (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= Math.floor(Date.now() / 1000))) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...securityHeaders('json'), ...CORS });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders('html') });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 1024 * 64): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readParams(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req);
  const ctype = req.headers['content-type'] ?? '';
  if (ctype.includes('application/json')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
        else if (v != null) p.set(k, String(v));
      }
      return p;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/* ------------------------------------------------------------------ */
/* client registration (stateless)                                     */
/* ------------------------------------------------------------------ */

/**
 * A client_id is itself a signed structure carrying the redirect URIs that
 * were registered with it. Nothing is stored; validity is re-derived from the
 * signature on every use, and a client_id cannot be forged without the secret.
 */
interface ClientRecord extends Record<string, unknown> {
  ru: string[];
  name?: string;
  iat: number;
}

function issueClient(redirectUris: string[], name?: string): string {
  return sign({ ru: redirectUris, name, iat: Math.floor(Date.now() / 1000) } satisfies ClientRecord);
}

function readClient(clientId: string): ClientRecord | null {
  const c = verify<ClientRecord>(clientId);
  if (!c || !Array.isArray(c.ru) || c.ru.length === 0) return null;
  return c;
}

/** Redirect URIs must be https, or http on loopback (RFC 8252). */
function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === 'localhost')) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* token verification for MCP requests                                 */
/* ------------------------------------------------------------------ */

interface AccessToken extends Record<string, unknown> {
  t: 'access';
  sub: string;
  aud?: string;
  exp: number;
}

export function bearerFrom(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim();
}

export function verifyAccessToken(token: string): boolean {
  const t = verify<AccessToken>(token);
  return !!t && t.t === 'access' && t.aud === EXTERNAL_URL;
}

/** 401 carrying the pointer Claude follows to discover how to authenticate. */
export function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${EXTERNAL_URL}/.well-known/oauth-protected-resource"`,
    ...CORS,
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

/* ------------------------------------------------------------------ */
/* login page                                                          */
/* ------------------------------------------------------------------ */

function loginPage(params: URLSearchParams, error?: string): string {
  const hidden = [...params.entries()]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111}
@media(prefers-color-scheme:dark){body{background:#15171a;color:#e9eaec}.card{background:#1e2126!important;border-color:#2c3037!important}}
.card{background:#fff;border:1px solid #e3e5e8;border-radius:14px;padding:32px;width:min(92vw,380px);
box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{margin:0 0 4px;font-size:19px}p.sub{margin:0 0 22px;opacity:.62;font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:11px 13px;font-size:16px;
border:1px solid #c9ccd1;border-radius:8px;background:transparent;color:inherit}
input[type=password]:focus{outline:2px solid #3b6ef6;outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:18px;padding:11px;font-size:15px;font-weight:600;color:#fff;
background:#1f6feb;border:0;border-radius:8px;cursor:pointer}
button:hover{background:#1a5fd0}
.err{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fdecec;color:#a32020;font-size:14px}
@media(prefers-color-scheme:dark){.err{background:#3a1d1d;color:#f3b0b0}}
</style></head><body><div class="card">
<h1>Shopmonkey MCP</h1><p class="sub">Sign in to authorize this connection.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" autocomplete="on">${hidden}
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autofocus required autocomplete="current-password">
<button type="submit">Authorize</button></form></div></body></html>`;
}

/* ------------------------------------------------------------------ */
/* request router                                                      */
/* ------------------------------------------------------------------ */

/** Returns true when the request was an OAuth endpoint and has been handled. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', EXTERNAL_URL || 'http://localhost');
  const path = url.pathname;
  const isOAuthPath =
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/openid-configuration' ||
    path === '/register' ||
    path === '/authorize' ||
    path === '/token';
  if (!isOAuthPath) return false;

  const limiterName = req.method === 'POST' && path === '/register'
    ? 'register'
    : req.method === 'POST' && path === '/authorize'
      ? 'authorize'
      : req.method === 'POST' && path === '/token'
        ? 'token'
        : null;
  if (limiterName) {
    const address = req.socket.remoteAddress ?? 'unknown';
    const result = endpointLimiters[limiterName].allow(`${limiterName}:${address}`);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      json(res, 429, { error: 'temporarily_unavailable' });
      return true;
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  /* ---- discovery ---- */
  if (path === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    json(res, 200, {
      resource: EXTERNAL_URL,
      authorization_servers: [EXTERNAL_URL],
      bearer_methods_supported: ['header'],
    });
    return true;
  }

  if (
    (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') &&
    req.method === 'GET'
  ) {
    json(res, 200, {
      issuer: EXTERNAL_URL,
      authorization_endpoint: `${EXTERNAL_URL}/authorize`,
      token_endpoint: `${EXTERNAL_URL}/token`,
      registration_endpoint: `${EXTERNAL_URL}/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    return true;
  }

  /* ---- dynamic client registration ---- */
  if (path === '/register' && req.method === 'POST') {
    const p = await readParams(req);
    const uris = p.getAll('redirect_uris').flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
    if (uris.length === 0) {
      json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
      return true;
    }
    for (const u of uris) {
      if (!validRedirectUri(u)) {
        json(res, 400, { error: 'invalid_redirect_uri', error_description: `rejected: ${u}` });
        return true;
      }
    }
    const clientId = issueClient(uris, p.get('client_name') ?? undefined);
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    return true;
  }

  /* ---- authorize ---- */
  if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
    const p = req.method === 'GET' ? url.searchParams : await readParams(req);

    const clientId = p.get('client_id') ?? '';
    const redirectUri = p.get('redirect_uri') ?? '';
    const state = p.get('state') ?? '';
    const challenge = p.get('code_challenge') ?? '';
    const method = p.get('code_challenge_method') ?? '';
    const resource = p.get('resource') ?? EXTERNAL_URL;

    const client = readClient(clientId);
    // Errors that cannot be safely redirected (unknown client / bad redirect)
    // must be shown here rather than sent onward, or we become an open redirect.
    if (!client) {
      html(res, 400, loginPage(new URLSearchParams(), 'Unknown or invalid client.'));
      return true;
    }
    if (!redirectUri || !client.ru.includes(redirectUri)) {
      html(res, 400, loginPage(new URLSearchParams(), 'redirect_uri does not match this client registration.'));
      return true;
    }

    const fail = (code: string, desc: string): void => {
      const to = new URL(redirectUri);
      to.searchParams.set('error', code);
      to.searchParams.set('error_description', desc);
      if (state) to.searchParams.set('state', state);
      res.writeHead(302, { Location: to.toString(), 'Cache-Control': 'no-store' });
      res.end();
    };

    if (resource !== EXTERNAL_URL) return (fail('invalid_target', 'resource does not match this server'), true);
    if (p.get('response_type') !== 'code') return (fail('unsupported_response_type', 'only code is supported'), true);
    if (method !== 'S256') return (fail('invalid_request', 'code_challenge_method must be S256'), true);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return (fail('invalid_request', 'invalid code_challenge'), true);

    // Carry the request parameters through the login form unchanged.
    const carry = new URLSearchParams();
    for (const k of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'resource', 'scope']) {
      const v = p.get(k);
      if (v) carry.set(k, v);
    }

    if (req.method === 'GET') {
      html(res, 200, loginPage(carry));
      return true;
    }

    const supplied = Buffer.from(p.get('password') ?? '', 'utf8');
    const expected = Buffer.from(PASSWORD, 'utf8');
    const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!ok) {
      html(res, 401, loginPage(carry, 'Incorrect password.'));
      return true;
    }

    const code = sign({
      t: 'code',
      sub: 'owner',
      cid: clientId,
      ru: redirectUri,
      cc: challenge,
      aud: resource,
      jti: b64u(randomBytes(12)),
      exp: Math.floor(Date.now() / 1000) + CODE_TTL,
    });

    const to = new URL(redirectUri);
    to.searchParams.set('code', code);
    if (state) to.searchParams.set('state', state);
    res.writeHead(302, { Location: to.toString(), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  /* ---- token ---- */
  if (path === '/token' && req.method === 'POST') {
    const p = await readParams(req);
    const grant = p.get('grant_type');

    if (grant === 'authorization_code') {
      const code = verify<{ t: string; cid: string; ru: string; cc: string; aud: string; exp: number }>(p.get('code') ?? '');
      if (!code || code.t !== 'code') {
        json(res, 400, { error: 'invalid_grant', error_description: 'authorization code invalid or expired' });
        return true;
      }
      if (p.get('client_id') !== code.cid) {
        json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
        return true;
      }
      if (p.get('redirect_uri') !== code.ru) {
        json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return true;
      }
      const verifier = p.get('code_verifier') ?? '';
      const derived = b64u(createHash('sha256').update(verifier, 'utf8').digest());
      const a = Buffer.from(derived, 'utf8');
      const b = Buffer.from(code.cc, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return true;
      }
      if (code.aud !== EXTERNAL_URL || (p.has('resource') && p.get('resource') !== code.aud) || !consume(p.get('code')!, 'code', code.exp)) {
        json(res, 400, { error: 'invalid_grant' });
        return true;
      }
      json(res, 200, issueTokens(code.cid, code.aud));
      return true;
    }

    if (grant === 'refresh_token') {
      const rt = verify<{ t: string; cid: string; aud: string; exp: number }>(p.get('refresh_token') ?? '');
      if (!rt || rt.t !== 'refresh' || p.get('client_id') !== rt.cid || rt.aud !== EXTERNAL_URL || (p.has('resource') && p.get('resource') !== rt.aud) || !consume(p.get('refresh_token')!, 'refresh', rt.exp)) {
        json(res, 400, { error: 'invalid_grant', error_description: 'refresh token invalid or expired' });
        return true;
      }
      json(res, 200, issueTokens(rt.cid, rt.aud));
      return true;
    }

    json(res, 400, { error: 'unsupported_grant_type' });
    return true;
  }

  json(res, 405, { error: 'method_not_allowed' });
  return true;
}

function issueTokens(cid: string, aud?: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: sign({ t: 'access', sub: 'owner', cid, aud, scope: 'mcp', exp: now + ACCESS_TTL }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: sign({ t: 'refresh', sub: 'owner', cid, aud, jti: b64u(randomBytes(24)), exp: now + REFRESH_TTL }),
    scope: 'mcp',
  };
}
