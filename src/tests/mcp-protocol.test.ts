import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, '..', 'index.js');

function startServer(): ChildProcess {
  return spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SHOPMONKEY_API_KEY: 'test-key-for-protocol-tests' },
  });
}

function collectAllOutput(child: ChildProcess, timeoutMs = 4000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr });
    }, timeoutMs);
  });
}

describe('MCP Protocol — Server Startup', () => {
  let server: ChildProcess;

  afterEach(() => {
    try { server?.kill(); } catch { /* already dead */ }
  });

  it('server process starts without crashing', async () => {
    server = startServer();
    const { stderr } = await collectAllOutput(server, 2000);
    assert.ok(!stderr.includes('Fatal error'), `Server crashed: ${stderr}`);
    assert.ok(!stderr.includes('Error:'), `Server error on startup: ${stderr}`);
  });

  it('server process does not crash without API key', async () => {
    server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SHOPMONKEY_API_KEY: '' },
    });
    const { stderr } = await collectAllOutput(server, 2000);
    // Server should start fine — API key is only checked when a tool is called
    assert.ok(!stderr.includes('Fatal error'), `Server crashed without API key: ${stderr}`);
  });
});

describe('MCP Protocol — Tool Count Verification', () => {
  it('server registers exactly 70 tools (verified via direct import)', async () => {
    const modules = await Promise.all([
      import('../tools/orders.js'),
      import('../tools/customers.js'),
      import('../tools/vehicles.js'),
      import('../tools/inventory.js'),
      import('../tools/appointments.js'),
      import('../tools/payments.js'),
      import('../tools/labor.js'),
      import('../tools/services.js'),
      import('../tools/workflow.js'),
      import('../tools/webhooks.js'),
      import('../tools/reports.js'),
      import('../tools/labels.js'),
    ]);

    const allDefinitions = modules.flatMap(m => m.definitions);
    assert.equal(allDefinitions.length, 70);

    // Verify no duplicates
    const names = allDefinitions.map(d => d.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size);
  });

  it('all tool definitions have required MCP fields', async () => {
    const modules = await Promise.all([
      import('../tools/orders.js'),
      import('../tools/customers.js'),
      import('../tools/vehicles.js'),
      import('../tools/inventory.js'),
      import('../tools/appointments.js'),
      import('../tools/payments.js'),
      import('../tools/labor.js'),
      import('../tools/services.js'),
      import('../tools/workflow.js'),
      import('../tools/webhooks.js'),
      import('../tools/reports.js'),
    ]);

    const allDefinitions = modules.flatMap(m => m.definitions);

    for (const tool of allDefinitions) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `Tool missing name`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `Tool "${tool.name}" missing description`);
      assert.ok(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`);
      const schema = tool.inputSchema as Record<string, unknown>;
      assert.equal(schema.type, 'object', `Tool "${tool.name}" inputSchema.type must be "object"`);
      assert.ok(schema.properties, `Tool "${tool.name}" missing inputSchema.properties`);
    }
  });

  it('all tool property descriptions exist for LLM consumption', async () => {
    const modules = await Promise.all([
      import('../tools/orders.js'),
      import('../tools/customers.js'),
      import('../tools/vehicles.js'),
      import('../tools/inventory.js'),
      import('../tools/appointments.js'),
      import('../tools/payments.js'),
      import('../tools/labor.js'),
      import('../tools/services.js'),
      import('../tools/workflow.js'),
      import('../tools/webhooks.js'),
      import('../tools/reports.js'),
    ]);

    const allDefinitions = modules.flatMap(m => m.definitions);

    for (const tool of allDefinitions) {
      const schema = tool.inputSchema as Record<string, unknown>;
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      for (const [propName, propSchema] of Object.entries(properties)) {
        assert.ok(
          propSchema.description && typeof propSchema.description === 'string',
          `Tool "${tool.name}" property "${propName}" missing description`
        );
      }
    }
  });

  it('handler map matches definition map exactly', async () => {
    const modules = await Promise.all([
      import('../tools/orders.js'),
      import('../tools/customers.js'),
      import('../tools/vehicles.js'),
      import('../tools/inventory.js'),
      import('../tools/appointments.js'),
      import('../tools/payments.js'),
      import('../tools/labor.js'),
      import('../tools/services.js'),
      import('../tools/workflow.js'),
      import('../tools/webhooks.js'),
      import('../tools/reports.js'),
    ]);

    const allDefinitions = modules.flatMap(m => m.definitions);
    const allHandlers: Record<string, unknown> = {};
    for (const mod of modules) {
      Object.assign(allHandlers, mod.handlers);
    }

    const defNames = new Set(allDefinitions.map(d => d.name));
    const handlerNames = new Set(Object.keys(allHandlers));

    // Every definition has a handler
    for (const name of defNames) {
      assert.ok(handlerNames.has(name), `Definition "${name}" has no handler`);
    }

    // Every handler has a definition
    for (const name of handlerNames) {
      assert.ok(defNames.has(name), `Handler "${name}" has no definition`);
    }
  });
});

describe('Private v2 release metadata', () => {
  it('identifies the CJVlady fork and Node 24 release', () => {
    const root = join(__dirname, '..', '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
      repository: { url: string };
      bugs: { url: string };
      homepage: string;
      engines: { node: string };
    };
    assert.equal(pkg.version, '2.0.0');
    assert.equal(pkg.repository.url, 'https://github.com/CJVlady/shopmonkey-mcp-server.git');
    assert.equal(pkg.bugs.url, 'https://github.com/CJVlady/shopmonkey-mcp-server/issues');
    assert.equal(pkg.homepage, 'https://github.com/CJVlady/shopmonkey-mcp-server#readme');
    assert.equal(pkg.engines.node, '>=24 <25');
  });

  it('documents source and production read-only tool counts', () => {
    const root = join(__dirname, '..', '..');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    assert.match(readme, /\*\*70 source tools\*\*/);
    assert.match(readme, /\*\*34 read-only production tools\*\*/);
  });
});
