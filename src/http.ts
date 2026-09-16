#!/usr/bin/env node
import 'dotenv/config';
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import {
  handleOAuth,
  bearerFrom,
  verifyAccessToken,
  unauthorized,
  oauthConfigError,
  initializeOAuthState,
  closeOAuthState,
  oauthReady,
} from './oauth.js';
import { requestLog, securityHeaders } from './http-security.js';

// Optional static bearer token, kept for curl/CI and non-OAuth clients.
// Unlike the previous behaviour, leaving it unset no longer opens the server:
// OAuth is always enforced.
const STATIC_TOKEN = process.env.MCP_AUTH_TOKEN;

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const presented = bearerFrom(req);
  if (presented) {
    if (verifyAccessToken(presented)) return true;
    if (STATIC_TOKEN && presented.length === STATIC_TOKEN.length && timingSafeEqual(
      Buffer.from(presented, 'utf8'), Buffer.from(STATIC_TOKEN, 'utf8'))) return true;
  }
  unauthorized(res);
  return false;
}

async function main(): Promise<void> {
  const PORT = Number(process.env.PORT ?? 3000);

  // Refuse to start misconfigured rather than serve an unprotected endpoint.
  const configError = oauthConfigError();
  if (configError) {
    process.stderr.write(`Refusing to start: ${configError}\n`);
    process.exit(1);
  }
  try {
    initializeOAuthState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Refusing to start: ${message}\n`);
    process.exit(1);
  }

  const httpServer = createHTTPServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    let logged = false;
    const logCompletion = (): void => {
      if (logged) return;
      logged = true;
      process.stderr.write(`${requestLog(req, res.statusCode, startedAt, requestId)}\n`);
    };
    res.once('finish', logCompletion);
    res.once('close', logCompletion);
    res.setHeader('X-Request-Id', requestId);
    for (const [name, value] of Object.entries(securityHeaders('json'))) res.setHeader(name, value);

    // D3: Health check — Railway / load balancer probes
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/ready') {
      const ready = oauthReady();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
      return;
    }

    // OAuth endpoints (discovery, registration, authorize, token) are public
    // by definition — they are how a client obtains credentials.
    try {
      if (await handleOAuth(req, res)) return;
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
      }
      return;
    }

    // Everything else requires a valid access token.
    if (!checkAuth(req, res)) return;

    // Stateless mode: create a fresh transport + server per request.
    // StreamableHTTPServerTransport is single-use in stateless mode —
    // sharing one instance across requests causes all requests after the
    // first to fail with 500.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createServer();
    await mcpServer.connect(transport);

    // Per-request instances must be closed when the response ends, or every
    // request leaks a transport and an McpServer (with its full tool registry)
    // for the lifetime of the process. Required by the SDK whenever a server is
    // created per request in stateless mode.
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      void Promise.resolve(transport.close()).catch(() => {});
      void Promise.resolve(mcpServer.close()).catch(() => {});
    };
    res.on('close', cleanup);

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      // Log the detail server-side; return a generic message. The error can
      // carry internal paths, upstream URLs and Shopmonkey error text, none of
      // which should reach an HTTP caller.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Request failed: ${message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  httpServer.listen(PORT, () => {
    const addr = httpServer.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
    process.stderr.write(`Shopmonkey MCP HTTP server listening on :${actualPort}\n`);
  });

  // D2: Graceful shutdown with force-kill timeout
  const shutdown = () => {
    httpServer.close(() => {
      closeOAuthState();
      process.exit(0);
    });
    setTimeout(() => {
      process.stderr.write('Shutdown timeout — forcing exit\n');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
