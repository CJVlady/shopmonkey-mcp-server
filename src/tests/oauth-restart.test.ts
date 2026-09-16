import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resource = 'https://bridge.example.com';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();

interface RunningServer {
  child: ChildProcess;
  base: string;
}

async function readToolNames(response: Response): Promise<string[]> {
  const text = await response.text();
  const payloads = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
    : [text];
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload) as { result?: { tools?: Array<{ name: string }> } };
      if (parsed.result?.tools) return parsed.result.tools.map(tool => tool.name);
    } catch { /* ignore non-JSON SSE frames */ }
  }
  assert.fail(`Could not parse tools/list response: ${text.slice(0, 500)}`);
}

function testEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '0',
    SHOPMONKEY_API_KEY: 'test-only',
    OAUTH_SIGNING_SECRET: 's'.repeat(48),
    OAUTH_PASSWORD: 'p'.repeat(32),
    EXTERNAL_URL: resource,
    MCP_ENABLE_WRITES: 'false',
    ...extra,
  };
}

async function startServer(statePath: string): Promise<RunningServer> {
  const child = spawn(process.execPath, ['dist/http.js'], {
    env: testEnvironment({ OAUTH_STATE_PATH: statePath }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
    child.stderr!.on('data', (data) => {
      const match = String(data).match(/listening on :(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`startup failed with ${code}`));
    });
  });
  return { child, base: `http://localhost:${port}` };
}

async function stopServer(server: RunningServer): Promise<void> {
  const exited = new Promise<void>((resolve) => server.child.once('exit', () => resolve()));
  server.child.kill('SIGTERM');
  await exited;
  children.delete(server.child);
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function authorizeAndExchange(base: string): Promise<{
  accessToken: string;
  code: string;
  clientId: string;
}> {
  const registration = await post(base, '/register', {
    redirect_uris: [redirect],
    client_name: 'Restart acceptance',
  });
  assert.equal(registration.status, 201);
  const clientId = String((await registration.json() as { client_id: string }).client_id);
  const authorization = await post(base, '/authorize', {
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
    password: 'p'.repeat(32),
  });
  assert.equal(authorization.status, 302);
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code')!;
  const tokenResponse = await post(base, '/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirect,
    code,
    code_verifier: verifier,
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as { access_token: string };
  return { accessToken: tokens.access_token, code, clientId };
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

test('access token and replay denial survive a server restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shopmonkey-restart-'));
  temporaryDirectories.push(directory);
  const statePath = join(directory, 'oauth.sqlite');
  const first = await startServer(statePath);
  const issued = await authorizeAndExchange(first.base);
  await stopServer(first);

  const second = await startServer(statePath);
  const tools = await fetch(second.base + '/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${issued.accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(tools.status, 200);
  const toolNames = await readToolNames(tools);
  assert.equal(toolNames.length, 34);
  assert.ok(toolNames.every(name => /^(get_|list_|search_|report_)/.test(name)));

  const replay = await post(second.base, '/token', {
    grant_type: 'authorization_code',
    client_id: issued.clientId,
    redirect_uri: redirect,
    code: issued.code,
    code_verifier: verifier,
  });
  assert.equal(replay.status, 400);
  await stopServer(second);
});

test('production refuses to start without OAUTH_STATE_PATH', async () => {
  const child = spawn(process.execPath, ['dist/http.js'], {
    env: testEnvironment({ OAUTH_STATE_PATH: '' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', (data) => { stderr += String(data); });

  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', resolve)),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
  ]);
  if (exitCode === 'timeout') child.kill('SIGKILL');

  assert.notEqual(exitCode, 'timeout');
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /OAUTH_STATE_PATH is required in production/);
});

test('production refuses invalid access and refresh token lifetimes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shopmonkey-ttl-'));
  temporaryDirectories.push(directory);

  for (const [name, value] of [
    ['ACCESS_TOKEN_TTL', 'not-a-number'],
    ['REFRESH_TOKEN_TTL', '-1'],
  ]) {
    const child = spawn(process.execPath, ['dist/http.js'], {
      env: testEnvironment({
        OAUTH_STATE_PATH: join(directory, `${name}.sqlite`),
        [name]: value,
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.add(child);
    let stderr = '';
    child.stderr!.on('data', (data) => { stderr += String(data); });

    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => child.once('exit', resolve)),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    if (exitCode === 'timeout') child.kill('SIGKILL');
    children.delete(child);

    assert.notEqual(exitCode, 'timeout');
    assert.notEqual(exitCode, 0);
    assert.match(stderr, new RegExp(`${name} must be a positive integer`));
  }
});
