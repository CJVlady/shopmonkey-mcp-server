import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type ConsumableTokenKind = 'code' | 'refresh';

export class OAuthStateStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS consumed_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('code', 'refresh')),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS consumed_tokens_expiry
        ON consumed_tokens(expires_at);
    `);
  }

  consume(token: string, kind: ConsumableTokenKind, expiry: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (!token || !Number.isFinite(expiry) || expiry <= now) return false;

    this.prune(now);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const result = this.database
      .prepare(`
        INSERT INTO consumed_tokens(token_hash, kind, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(token_hash) DO NOTHING
      `)
      .run(tokenHash, kind, expiry);
    return result.changes === 1;
  }

  ready(): boolean {
    const row = this.database.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  prune(now = Math.floor(Date.now() / 1000)): number {
    const result = this.database
      .prepare('DELETE FROM consumed_tokens WHERE expires_at <= ?')
      .run(now);
    return Number(result.changes);
  }

  close(): void {
    this.database.close();
  }
}
