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
  MemoryRepository,
  DEFAULT_USER_ID,
  type CreateMemoryInput,
} from '../src/db/index.js';

describe('Personal Memory Repository & Schema Tests (Milestone 7A)', () => {
  it('Migration 002: applies cleanly and records in _migrations table', () => {
    const { db } = initDatabase({ path: ':memory:' });

    const rows = db.prepare('SELECT id, description FROM _migrations ORDER BY rowid ASC').all() as Array<{
      id: string;
      description: string;
    }>;

    assert.ok(rows.length >= 2, 'Migrations must be applied');
    assert.equal(rows[0]?.id, '001_initial_schema');
    assert.equal(rows[1]?.id, '002_memories_schema');

    // Verify memories table exists
    const tableInfo = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get();
    assert.ok(tableInfo, 'memories table must exist');

    // Verify migration repeatability (idempotency)
    const repeated = runMigrations(db);
    assert.equal(repeated.applied.length, 0, 'Repeated migrations must not apply any new migrations');
    assert.equal(repeated.totalApplied >= 2, true);
    assert.equal(repeated.skipped.length >= 2, true);

    closeDatabase(db);
  });

  it('MemoryRepository: creates and retrieves memories with backend-generated UUIDs', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    const input: CreateMemoryInput = {
      category: 'personal_fact',
      content: 'Lives in Hyderabad, Telangana',
      metadata: { sourceConfidence: 0.95 },
    };

    const created = repo.createMemory(input);

    // Verify backend-generated UUID
    assert.ok(created.id, 'Memory must have an ID');
    assert.match(
      created.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'ID must be a valid UUIDv4'
    );
    assert.equal(created.userId, DEFAULT_USER_ID);
    assert.equal(created.category, 'personal_fact');
    assert.equal(created.content, 'Lives in Hyderabad, Telangana');
    assert.equal(created.source, 'explicit_user');
    assert.equal(created.status, 'active');
    assert.ok(created.createdAt);
    assert.equal(created.createdAt, created.updatedAt);
    assert.deepEqual(created.metadata, { sourceConfidence: 0.95 });

    // Retrieve by ID
    const retrieved = repo.getMemory(created.id);
    assert.ok(retrieved);
    assert.deepEqual(retrieved, created);

    closeDatabase(db);
  });

  it('MemoryRepository: supports all 4 categories and all 3 statuses', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    const m1 = repo.createMemory({
      category: 'personal_fact',
      content: 'Speaks Telugu and English fluently',
      status: 'active',
    });

    const m2 = repo.createMemory({
      category: 'preference',
      content: 'Prefers concise voice responses under 2 sentences',
      status: 'active',
    });

    const m3 = repo.createMemory({
      category: 'goal',
      content: 'Preparing for AWS Solutions Architect certification',
      status: 'suggested',
      source: 'assistant_suggested',
    });

    const m4 = repo.createMemory({
      category: 'context',
      content: 'Developing ATLAS voice assistant backend on macOS',
      status: 'archived',
    });

    assert.equal(m1.category, 'personal_fact');
    assert.equal(m2.category, 'preference');
    assert.equal(m3.category, 'goal');
    assert.equal(m3.status, 'suggested');
    assert.equal(m3.source, 'assistant_suggested');
    assert.equal(m4.category, 'context');
    assert.equal(m4.status, 'archived');

    assert.equal(repo.countMemories(), 4);

    closeDatabase(db);
  });

  it('MemoryRepository: filters by category, status, search substring, and limit', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    repo.createMemory({ category: 'preference', content: 'Prefers TypeScript', status: 'active' });
    repo.createMemory({ category: 'preference', content: 'Prefers dark mode in UI', status: 'active' });
    repo.createMemory({ category: 'goal', content: 'Complete Milestone 7 of ATLAS', status: 'active' });
    repo.createMemory({ category: 'goal', content: 'Study AWS Cloud Practitioner', status: 'suggested' });
    repo.createMemory({ category: 'personal_fact', content: 'Software engineer in Hyderabad', status: 'active' });

    // 1. Filter by category
    const preferences = repo.listMemories({ category: 'preference' });
    assert.equal(preferences.length, 2);
    assert.ok(preferences.every((m) => m.category === 'preference'));

    // 2. Filter by status
    const suggested = repo.listMemories({ status: 'suggested' });
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0]?.content, 'Study AWS Cloud Practitioner');

    // 3. Combined filter (category + status)
    const activeGoals = repo.listMemories({ category: 'goal', status: 'active' });
    assert.equal(activeGoals.length, 1);
    assert.equal(activeGoals[0]?.content, 'Complete Milestone 7 of ATLAS');

    // 4. Substring search in content
    const searchResults = repo.listMemories({ search: 'TypeScript' });
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0]?.content, 'Prefers TypeScript');

    // 5. Limit results
    const limited = repo.listMemories({ limit: 2 });
    assert.equal(limited.length, 2);

    closeDatabase(db);
  });

  it('MemoryRepository: updates memory content, category, status, and metadata cleanly', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    const created = repo.createMemory({
      category: 'goal',
      content: 'Pass AWS exam',
      status: 'suggested',
      source: 'assistant_suggested',
    });

    // Small delay to verify updatedAt changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = repo.updateMemory(created.id, {
      content: 'Pass AWS Solutions Architect Associate exam in December',
      status: 'active',
      metadata: { confirmedAt: new Date().toISOString() },
    });

    assert.ok(updated);
    assert.equal(updated.id, created.id);
    assert.equal(updated.content, 'Pass AWS Solutions Architect Associate exam in December');
    assert.equal(updated.status, 'active');
    assert.equal(updated.category, 'goal');
    assert.ok(updated.updatedAt >= created.createdAt);
    assert.ok(updated.metadata?.confirmedAt);

    // Verify update persisted in database
    const inDb = repo.getMemory(created.id);
    assert.deepEqual(inDb, updated);

    // Update non-existent memory returns undefined
    const nonExistent = repo.updateMemory('non-existent-id', { content: 'test' });
    assert.equal(nonExistent, undefined);

    closeDatabase(db);
  });

  it('MemoryRepository: hard deletes memory and removes it from queries', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    const m1 = repo.createMemory({ category: 'personal_fact', content: 'Fact 1' });
    const m2 = repo.createMemory({ category: 'personal_fact', content: 'Fact 2' });

    assert.equal(repo.countMemories(), 2);

    // Delete m1
    const deleted = repo.deleteMemory(m1.id);
    assert.equal(deleted, true);

    // Subsequent retrieval must be undefined
    assert.equal(repo.getMemory(m1.id), undefined);
    assert.equal(repo.countMemories(), 1);

    // m2 must still exist
    const remaining = repo.getMemory(m2.id);
    assert.ok(remaining);
    assert.equal(remaining.content, 'Fact 2');

    // Deleting already deleted or non-existent ID returns false
    assert.equal(repo.deleteMemory(m1.id), false);
    assert.equal(repo.deleteMemory('unknown-id'), false);

    closeDatabase(db);
  });

  it('MemoryRepository: enforces strict input validation', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    // 1. Invalid category
    assert.throws(
      () => {
        repo.createMemory({ category: 'invalid_cat' as any, content: 'Some fact' });
      },
      (err: Error) => err.message.includes('Invalid memory category')
    );

    // 2. Invalid status
    assert.throws(
      () => {
        repo.createMemory({ category: 'goal', content: 'Some goal', status: 'invalid_status' as any });
      },
      (err: Error) => err.message.includes('Invalid memory status')
    );

    // 3. Invalid source
    assert.throws(
      () => {
        repo.createMemory({ category: 'goal', content: 'Some goal', source: 'invalid_source' as any });
      },
      (err: Error) => err.message.includes('Invalid memory source')
    );

    // 4. Empty content
    assert.throws(
      () => {
        repo.createMemory({ category: 'goal', content: '' });
      },
      (err: Error) => err.message.includes('cannot be empty')
    );

    // 5. Whitespace-only content
    assert.throws(
      () => {
        repo.createMemory({ category: 'goal', content: '    ' });
      },
      (err: Error) => err.message.includes('cannot be empty')
    );

    // 6. Content exceeding 1000 characters
    const overlong = 'x'.repeat(1001);
    assert.throws(
      () => {
        repo.createMemory({ category: 'goal', content: overlong });
      },
      (err: Error) => err.message.includes('cannot exceed 1000 characters')
    );

    // 7. Invalid update content
    const m = repo.createMemory({ category: 'goal', content: 'Valid goal' });
    assert.throws(
      () => {
        repo.updateMemory(m.id, { content: '   ' });
      },
      (err: Error) => err.message.includes('cannot be empty')
    );

    // 8. Invalid update category
    assert.throws(
      () => {
        repo.updateMemory(m.id, { category: 'wrong' as any });
      },
      (err: Error) => err.message.includes('Invalid memory category')
    );

    closeDatabase(db);
  });

  it('MemoryRepository: supports user/profile isolation while defaulting to single-user', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    // User A (default)
    const memDefault = repo.createMemory({
      category: 'personal_fact',
      content: 'Default user fact',
    });
    assert.equal(memDefault.userId, DEFAULT_USER_ID);

    // User B (explicit userId)
    const memAlice = repo.createMemory({
      userId: 'user_alice',
      category: 'personal_fact',
      content: 'Alice fact',
    });
    assert.equal(memAlice.userId, 'user_alice');

    // Retrieval isolation
    assert.ok(repo.getMemory(memDefault.id, DEFAULT_USER_ID));
    assert.equal(repo.getMemory(memDefault.id, 'user_alice'), undefined);

    assert.ok(repo.getMemory(memAlice.id, 'user_alice'));
    assert.equal(repo.getMemory(memAlice.id, DEFAULT_USER_ID), undefined);

    // Listing isolation
    const defaultList = repo.listMemories();
    assert.equal(defaultList.length, 1);
    assert.equal(defaultList[0]?.content, 'Default user fact');

    const aliceList = repo.listMemories({ userId: 'user_alice' });
    assert.equal(aliceList.length, 1);
    assert.equal(aliceList[0]?.content, 'Alice fact');

    // Cross-user deletion prevention
    assert.equal(repo.deleteMemory(memAlice.id, DEFAULT_USER_ID), false);
    assert.ok(repo.getMemory(memAlice.id, 'user_alice'), 'Memory must not be deleted by another user');

    closeDatabase(db);
  });

  it('MemoryRepository: session origin optionality and ON DELETE SET NULL cascade', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MemoryRepository(db);

    // 1. Create a session in sessions table
    const sessionId = 'session-test-origin';
    db.prepare(`
      INSERT INTO sessions (id, connection_id, created_at, status)
      VALUES (?, 'conn-1', ?, 'active')
    `).run(sessionId, new Date().toISOString());

    // 2. Create memory originating from that session
    const mem = repo.createMemory({
      category: 'context',
      content: 'Memory originated from session-test-origin',
      sessionId,
    });
    assert.equal(mem.sessionId, sessionId);

    // 3. Delete the session
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    // 4. Memory must remain intact, with session_id set to null/undefined
    const retrieved = repo.getMemory(mem.id);
    assert.ok(retrieved, 'Memory must outlive its originating session');
    assert.equal(retrieved.sessionId, undefined, 'session_id must be nullified via ON DELETE SET NULL');
    assert.equal(retrieved.content, 'Memory originated from session-test-origin');

    closeDatabase(db);
  });

  it('MemoryRepository: data persists across database connection close and reopen on disk', () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const tempDir = path.resolve(currentDir, '../data/test-memory-temp');
    const tempDbPath = path.resolve(tempDir, 'memory-persist.db');

    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

    // 1. Open disk database, run migrations, create memory
    const { db: db1 } = initDatabase({ path: tempDbPath });
    const repo1 = new MemoryRepository(db1);

    const created = repo1.createMemory({
      category: 'goal',
      content: 'Persistent goal across SQLite reopen',
      metadata: { testKey: 'testVal' },
    });

    closeDatabase(db1);

    // 2. Reopen connection to same disk database
    const db2 = createDatabaseConnection({ path: tempDbPath });
    const repo2 = new MemoryRepository(db2);

    const reloaded = repo2.getMemory(created.id);
    assert.ok(reloaded, 'Memory must exist after reopening disk database');
    assert.equal(reloaded.id, created.id);
    assert.equal(reloaded.content, 'Persistent goal across SQLite reopen');
    assert.equal(reloaded.category, 'goal');
    assert.deepEqual(reloaded.metadata, { testKey: 'testVal' });

    closeDatabase(db2);

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
});
