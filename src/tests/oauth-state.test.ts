import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OAuthStateStore } from '../oauth-state.js';

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shopmonkey-oauth-'));
  temporaryDirectories.push(directory);
  return join(directory, 'oauth.sqlite');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

test('consumes a token exactly once', () => {
  const store = new OAuthStateStore(temporaryDatabase());
  const expiry = Math.floor(Date.now() / 1000) + 60;

  assert.equal(store.consume('authorization-code', 'code', expiry), true);
  assert.equal(store.consume('authorization-code', 'code', expiry), false);
  store.close();
});

test('consumed tokens remain blocked after reopening the database', () => {
  const path = temporaryDatabase();
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const first = new OAuthStateStore(path);
  assert.equal(first.consume('refresh-token', 'refresh', expiry), true);
  first.close();

  const second = new OAuthStateStore(path);
  assert.equal(second.consume('refresh-token', 'refresh', expiry), false);
  second.close();
});

test('stores only a SHA-256 token hash', () => {
  const path = temporaryDatabase();
  const rawToken = 'sensitive-raw-token';
  const store = new OAuthStateStore(path);
  store.consume(rawToken, 'code', Math.floor(Date.now() / 1000) + 60);
  store.close();

  const database = new DatabaseSync(path, { readOnly: true });
  const row = database.prepare('SELECT token_hash, kind FROM consumed_tokens').get() as {
    token_hash: string;
    kind: string;
  };
  database.close();

  assert.equal(row.token_hash, createHash('sha256').update(rawToken).digest('hex'));
  assert.equal(row.kind, 'code');
  assert.ok(!JSON.stringify(row).includes(rawToken));
});

test('prunes expired entries and rejects already-expired tokens', () => {
  const store = new OAuthStateStore(temporaryDatabase());
  const now = Math.floor(Date.now() / 1000);

  assert.equal(store.consume('expired', 'code', now - 1), false);
  assert.equal(store.consume('live', 'refresh', now + 60), true);
  assert.equal(store.prune(now + 61), 1);
  assert.equal(store.ready(), true);
  store.close();
});
