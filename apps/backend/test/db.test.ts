import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabaseConnection,
  initDatabase,
  closeDatabase,
  runMigrations,
  type Migration,
} from '../src/db/index.js';
import { resolveDatabasePath } from '../src/config/index.js';
import { buildApp } from '../src/app.js';

describe('SQLite Database Foundation Unit & Integration Tests', () => {
  it('Creates an in-memory database connection successfully', () => {
    const db = createDatabaseConnection({ path: ':memory:' });
    assert.ok(db);
    assert.equal(db.open, true);

    const row = db.prepare('SELECT 42 AS value').get() as { value: number };
    assert.equal(row.value, 42);

    closeDatabase(db);
    assert.equal(db.open, false);
  });

  it('Configures mandatory PRAGMAs: foreign_keys, busy_timeout, and journal_mode', () => {
    // 1. In-memory pragmas
    const memDb = createDatabaseConnection({ path: ':memory:' });
    const fkRow = memDb.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    const timeoutRow = memDb.pragma('busy_timeout') as Array<{ timeout: number }>;

    assert.equal(fkRow[0]?.foreign_keys, 1, 'foreign_keys must be ON');
    assert.equal(timeoutRow[0]?.timeout, 5000, 'busy_timeout must be 5000ms');
    closeDatabase(memDb);

    // 2. Disk database WAL pragma
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const tempDir = path.resolve(currentDir, '../data/test-temp');
    const tempDbPath = path.resolve(tempDir, 'test-wal.db');

    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

    const diskDb = createDatabaseConnection({ path: tempDbPath });
    const journalRow = diskDb.pragma('journal_mode') as Array<{ journal_mode: string }>;

    assert.equal(journalRow[0]?.journal_mode, 'wal', 'journal_mode must be WAL for disk database');

    closeDatabase(diskDb);

    // Clean up temporary files
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      const walFile = `${tempDbPath}-wal`;
      const shmFile = `${tempDbPath}-shm`;
      if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
      if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch {
      // Ignore cleanup error in test
    }
  });

  it('Enforces foreign key constraints and cascade delete', () => {
    const db = createDatabaseConnection({ path: ':memory:' });

    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
      );
    `);

    db.prepare('INSERT INTO parent (id) VALUES (?)').run('p1');
    db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'p1');

    // Attempt invalid foreign key insert
    assert.throws(
      () => {
        db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c2', 'non-existent-parent');
      },
      (err: Error) => err.message.includes('FOREIGN KEY constraint failed')
    );

    // Cascade delete on parent removal
    db.prepare('DELETE FROM parent WHERE id = ?').run('p1');
    const remainingChildren = db.prepare('SELECT * FROM child').all();
    assert.equal(remainingChildren.length, 0, 'Child must be cascade-deleted');

    closeDatabase(db);
  });

  it('Creates parent directory when opening a disk-based database', () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const nestedDir = path.resolve(currentDir, '../data/nested/level/test');
    const nestedDbPath = path.resolve(nestedDir, 'nested.db');

    assert.equal(fs.existsSync(nestedDir), false);

    const db = createDatabaseConnection({ path: nestedDbPath });
    assert.equal(fs.existsSync(nestedDir), true);
    assert.equal(db.open, true);

    closeDatabase(db);

    // Cleanup
    try {
      if (fs.existsSync(nestedDbPath)) fs.unlinkSync(nestedDbPath);
      const walFile = `${nestedDbPath}-wal`;
      const shmFile = `${nestedDbPath}-shm`;
      if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
      if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
      fs.rmSync(path.resolve(currentDir, '../data/nested'), { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('Executes migrations and tracks them in _migrations table', () => {
    const { db, migrations } = initDatabase({ path: ':memory:' });
    assert.ok(db.open);
    assert.ok(migrations.applied.includes('001_initial_schema'));
    assert.ok(migrations.applied.includes('002_memories_schema'));
    assert.ok(migrations.applied.includes('003_conversation_recall'));
    assert.equal(migrations.totalApplied >= 3, true);

    // Verify _migrations table records
    const migrationRows = db.prepare('SELECT * FROM _migrations ORDER BY rowid ASC').all() as Array<{
      id: string;
      description: string;
      applied_at: string;
    }>;
    assert.equal(migrationRows.length, 3);
    assert.equal(migrationRows[0]?.id, '001_initial_schema');
    assert.equal(migrationRows[1]?.id, '002_memories_schema');
    assert.equal(migrationRows[2]?.id, '003_conversation_recall');

    // Verify created tables exist
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);

    assert.ok(tables.includes('_migrations'));
    assert.ok(tables.includes('sessions'));
    assert.ok(tables.includes('messages'));
    assert.ok(tables.includes('memories'));

    closeDatabase(db);
  });

  it('Is safe and idempotent on repeated migration execution', () => {
    const db = createDatabaseConnection({ path: ':memory:' });

    // First run
    const result1 = runMigrations(db);
    assert.ok(result1.applied.includes('001_initial_schema'));
    assert.ok(result1.applied.includes('002_memories_schema'));
    assert.ok(result1.applied.includes('003_conversation_recall'));
    assert.equal(result1.skipped.length, 0);

    // Second run on same connection
    const result2 = runMigrations(db);
    assert.equal(result2.applied.length, 0, 'No new migrations should be applied');
    assert.ok(result2.skipped.includes('001_initial_schema'));
    assert.ok(result2.skipped.includes('002_memories_schema'));
    assert.ok(result2.skipped.includes('003_conversation_recall'));
    assert.equal(result2.totalApplied, 3);

    closeDatabase(db);
  });

  it('Rolls back migration in a transaction if a migration step fails', () => {
    const db = createDatabaseConnection({ path: ':memory:' });

    const failingMigration: Migration = {
      id: 'failing_migration',
      description: 'Will fail midway',
      up: (database) => {
        database.exec('CREATE TABLE temp_table (id TEXT PRIMARY KEY);');
        // Syntax error to trigger transaction rollback
        database.exec('INVALID SQL STATEMENT HERE;');
      },
    };

    assert.throws(
      () => {
        runMigrations(db, [failingMigration]);
      },
      (err: Error) => err.message.includes('syntax error') || err.message.includes('INVALID')
    );

    // Verify temp_table was rolled back and not persisted
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'temp_table'")
      .get();
    assert.equal(tableExists, undefined, 'Table from failed transaction must be rolled back');

    // Verify migration was NOT marked as applied
    const appliedRecord = db
      .prepare("SELECT * FROM _migrations WHERE id = 'failing_migration'")
      .get();
    assert.equal(appliedRecord, undefined);

    closeDatabase(db);
  });

  it('Integrates database lifecycle cleanly with Fastify buildApp and onClose hook', async () => {
    const app = buildApp({ logger: false, db: createDatabaseConnection({ path: ':memory:' }) });
    assert.ok(app.db);
    assert.equal(app.db.open, true);

    // Verify health endpoint still works without issues
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);

    // Closing app must trigger onClose and close database connection
    await app.close();
    assert.equal(app.db.open, false, 'Database must be closed upon Fastify onClose');
  });

  it('resolveDatabasePath resolves memory for tests and absolute path for disk', () => {
    // 1. Explicit :memory:
    assert.equal(resolveDatabasePath(':memory:', 'development'), ':memory:');
    assert.equal(resolveDatabasePath(':memory:', 'test'), ':memory:');

    // 2. Test environment defaults to :memory: when not set
    assert.equal(resolveDatabasePath(undefined, 'test'), ':memory:');

    // 3. Development environment defaults to absolute path inside apps/backend/data/
    const devPath = resolveDatabasePath(undefined, 'development');
    assert.ok(path.isAbsolute(devPath));
    assert.ok(devPath.endsWith('apps/backend/data/atlas.db'));

    // 4. Custom relative path resolves to absolute path
    const customPath = resolveDatabasePath('custom/dir/test.db', 'production');
    assert.ok(path.isAbsolute(customPath));
    assert.ok(customPath.endsWith('apps/backend/custom/dir/test.db'));
  });
});

