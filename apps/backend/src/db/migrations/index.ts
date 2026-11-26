import type Database from 'better-sqlite3';
import type { Migration } from './types.js';
import { migration001 } from './001_initial_schema.js';
import { migration002 } from './002_memories_schema.js';
import { migration003 } from './003_conversation_recall.js';

export * from './types.js';
export * from './001_initial_schema.js';
export * from './002_memories_schema.js';
export * from './003_conversation_recall.js';

export const migrations: readonly Migration[] = [migration001, migration002, migration003];

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  totalApplied: number;
}

/**
 * Executes database migrations in transactions, recording applied migrations
 * in the _migrations table to guarantee idempotency and repeat safety.
 */
export function runMigrations(
  db: Database.Database,
  migrationList: readonly Migration[] = migrations
): MigrationResult {
  // 1. Ensure migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // 2. Retrieve set of already applied migration IDs
  const appliedRows = db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>;
  const appliedIds = new Set<string>(appliedRows.map((r) => r.id));

  const applied: string[] = [];
  const skipped: string[] = [];

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (id, description, applied_at) VALUES (?, ?, ?)'
  );

  // 3. Run migration inside a dedicated transaction
  const executeMigration = db.transaction((m: Migration) => {
    m.up(db);
    insertMigration.run(m.id, m.description, new Date().toISOString());
  });

  for (const m of migrationList) {
    if (appliedIds.has(m.id)) {
      skipped.push(m.id);
      continue;
    }

    executeMigration(m);
    applied.push(m.id);
    appliedIds.add(m.id);
  }

  return {
    applied,
    skipped,
    totalApplied: appliedIds.size,
  };
}

