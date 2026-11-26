import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  initDatabase,
  closeDatabase,
  runMigrations,
  migrations,
} from '../src/db/index.js';
import {
  RecallRepository,
  tokenizeFts5Query,
} from '../src/db/repositories/recallRepository.js';
import { MessageRepository } from '../src/db/repositories/messageRepository.js';
import { SessionRepository } from '../src/db/repositories/sessionRepository.js';
import { assertFts5Available } from '../src/db/migrations/003_conversation_recall.js';

describe('ATLAS Milestone 7C.1: Conversation Recall Schema & Repository', () => {
  it('Migration 003: applies cleanly, creates messages_fts, and registers in _migrations', () => {
    const { db } = initDatabase({ path: ':memory:' });

    const rows = db.prepare('SELECT id, description FROM _migrations ORDER BY rowid ASC').all() as Array<{
      id: string;
      description: string;
    }>;

    assert.ok(rows.some((r) => r.id === '003_conversation_recall'), '003_conversation_recall must be applied');

    // Verify messages_fts virtual table exists
    const ftsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
      .get();
    assert.ok(ftsTable, 'messages_fts virtual table must exist');

    // Verify user_id column exists on sessions table
    const sessionCols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
    assert.ok(sessionCols.some((c) => c.name === 'user_id'), 'sessions table must contain user_id column');

    // Verify index on user_id exists
    const userIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_user'")
      .get();
    assert.ok(userIndex, 'idx_sessions_user index must exist');

    closeDatabase(db);
  });

  it('Migration 003: is idempotent and safe on repeated execution', () => {
    const { db } = initDatabase({ path: ':memory:' });

    const repeated = runMigrations(db, migrations);
    assert.equal(repeated.applied.length, 0, 'No migrations should run on second pass');
    assert.ok(repeated.skipped.includes('003_conversation_recall'));

    closeDatabase(db);
  });

  it('assertFts5Available: verifies FTS5 availability and throws clear error if unsupported', () => {
    const { db } = initDatabase({ path: ':memory:' });

    // Should succeed on standard system with FTS5
    assert.doesNotThrow(() => {
      assertFts5Available(db);
    });

    // Mock an unsupported engine by passing a mock object that throws on FTS5 probe
    const mockDb = {
      prepare: () => {
        throw new Error('compileoption not supported');
      },
      exec: () => {
        throw new Error('no such module: fts5');
      },
    } as unknown as Database.Database;

    assert.throws(
      () => {
        assertFts5Available(mockDb);
      },
      (err: Error) => {
        return err.message.includes('SQLite FTS5 extension is not available') &&
          err.message.includes('ATLAS Conversation Recall requires SQLite with FTS5 enabled');
      }
    );

    closeDatabase(db);
  });

  it('Backfill: populates existing messages into messages_fts when migration 003 runs', () => {
    // 1. Create a fresh database with only migration 001 and 002
    const db = new Database(':memory:');
    runMigrations(db, migrations.slice(0, 2));

    // 2. Insert messages before migration 003 exists
    db.prepare('INSERT INTO sessions (id, connection_id, created_at, status) VALUES (?, ?, ?, ?)').run(
      'pre-session-1',
      'conn-1',
      '2026-11-13T10:00:00Z',
      'ended'
    );
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'pre-msg-1',
      'pre-session-1',
      'user',
      'Can you explain quantum computing basics?',
      '2026-11-13T10:00:01Z'
    );
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'pre-msg-2',
      'pre-session-1',
      'assistant',
      'Quantum computing utilizes qubits and superposition.',
      '2026-11-13T10:00:02Z'
    );

    // 3. Apply migration 003
    const result = runMigrations(db, migrations);
    assert.ok(result.applied.includes('003_conversation_recall'));

    // 4. Verify messages are now searchable in messages_fts
    const recallRepo = new RecallRepository(db);
    const quantumMatches = recallRepo.searchHistoricalExchanges({
      query: 'quantum superposition',
    });

    assert.equal(quantumMatches.length, 1);
    assert.equal(quantumMatches[0]?.matchedMessage.sessionId, 'pre-session-1');
    assert.equal(quantumMatches[0]?.exchangeMessages.length, 2);

    // 5. Verify sessions table user_id was backfilled with default_user
    const sessionRow = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get('pre-session-1') as {
      user_id: string;
    };
    assert.equal(sessionRow.user_id, 'default_user');

    closeDatabase(db);
  });

  it('Triggers: INSERT, UPDATE, and DELETE triggers synchronize messages_fts', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const recallRepo = new RecallRepository(db);

    const sessionId = crypto.randomUUID();
    const msgId = crypto.randomUUID();

    // 1. INSERT trigger verification
    messageRepo.addMessage(sessionId, {
      id: msgId,
      role: 'user',
      content: 'I want to build a distributed raft consensus cluster in Go.',
      timestamp: new Date().toISOString(),
    });

    let results = recallRepo.searchHistoricalExchanges({ query: 'raft consensus' });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.matchedMessage.id, msgId);

    // 2. UPDATE trigger verification
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(
      'I want to build a Paxos consensus cluster in Rust.',
      msgId
    );

    const oldResults = recallRepo.searchHistoricalExchanges({ query: 'raft Go' });
    assert.equal(oldResults.length, 0, 'Old message content should no longer match');

    const newResults = recallRepo.searchHistoricalExchanges({ query: 'Paxos Rust' });
    assert.equal(newResults.length, 1, 'Updated content should match immediately');
    assert.equal(newResults[0]?.matchedMessage.content, 'I want to build a Paxos consensus cluster in Rust.');

    // 3. DELETE trigger verification
    messageRepo.removeMessage(sessionId, msgId);

    const deletedResults = recallRepo.searchHistoricalExchanges({ query: 'Paxos' });
    assert.equal(deletedResults.length, 0, 'Deleted message must be purged from FTS index');

    closeDatabase(db);
  });

  it('Cross-session search: finds relevant exchanges across multiple historical sessions', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);

    // Create session 1 (Architecture discussion)
    const session1Id = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: session1Id,
      connectionId: 'conn-1',
      createdAt: new Date('2026-11-10T09:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });
    messageRepo.addMessage(session1Id, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'What database should we use for ATLAS voice assistant?',
      timestamp: '2026-11-10T09:00:01Z',
    });
    messageRepo.addMessage(session1Id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'We should use SQLite with better-sqlite3 and WAL journal mode.',
      timestamp: '2026-11-10T09:00:02Z',
    });

    // Create session 2 (Cooking recipe - unrelated)
    const session2Id = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: session2Id,
      connectionId: 'conn-2',
      createdAt: new Date('2026-11-11T12:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });
    messageRepo.addMessage(session2Id, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'How do I cook homemade sourdough bread?',
      timestamp: '2026-11-11T12:00:01Z',
    });
    messageRepo.addMessage(session2Id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Mix flour, water, salt, and sourdough starter, then ferment.',
      timestamp: '2026-11-11T12:00:02Z',
    });

    // Create session 3 (Database optimization discussion)
    const session3Id = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: session3Id,
      connectionId: 'conn-3',
      createdAt: new Date('2026-11-12T15:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });
    messageRepo.addMessage(session3Id, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'How do we configure SQLite busy timeout and foreign keys?',
      timestamp: '2026-11-12T15:00:01Z',
    });
    messageRepo.addMessage(session3Id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Configure PRAGMA busy_timeout = 5000 and PRAGMA foreign_keys = ON.',
      timestamp: '2026-11-12T15:00:02Z',
    });

    // Search across all sessions for "SQLite"
    const results = recallRepo.searchHistoricalExchanges({
      query: 'SQLite database timeout',
      limit: 5,
    });

    assert.equal(results.length, 2, 'Should match session 1 and session 3, but not sourdough bread session 2');
    const matchedSessionIds = results.map((r) => r.matchedMessage.sessionId);
    assert.ok(matchedSessionIds.includes(session1Id));
    assert.ok(matchedSessionIds.includes(session3Id));
    assert.ok(!matchedSessionIds.includes(session2Id));

    closeDatabase(db);
  });

  it('Current-session exclusion: strictly excludes messages from the active session', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);

    const oldSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();

    sessionRepo.createSession({
      sessionId: oldSessionId,
      connectionId: 'conn-old',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
    });
    sessionRepo.createSession({
      sessionId: currentSessionId,
      connectionId: 'conn-current',
      createdAt: new Date('2026-11-13T10:00:00Z'),
      status: 'active',
    });

    messageRepo.addMessage(oldSessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Tell me about Node.js event loop architecture.',
      timestamp: '2026-11-10T10:00:01Z',
    });

    messageRepo.addMessage(currentSessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'I also want to discuss the Node.js event loop right now.',
      timestamp: '2026-11-13T10:00:01Z',
    });

    // Search with currentSessionId exclusion
    const results = recallRepo.searchHistoricalExchanges({
      query: 'Node.js event loop',
      currentSessionId,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.matchedMessage.sessionId, oldSessionId);
    assert.notEqual(results[0]?.matchedMessage.sessionId, currentSessionId);

    closeDatabase(db);
  });

  it('User isolation: strictly segregates historical messages between different users', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);

    const userASession = crypto.randomUUID();
    const userBSession = crypto.randomUUID();

    sessionRepo.createSession({
      sessionId: userASession,
      connectionId: 'conn-A',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });

    sessionRepo.createSession({
      sessionId: userBSession,
      connectionId: 'conn-B',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
      userId: 'user_bob',
    });

    messageRepo.addMessage(userASession, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'My secret project codename is Project Chronos.',
      timestamp: '2026-11-10T10:00:01Z',
    });

    messageRepo.addMessage(userBSession, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'My secret project codename is Project Chronos.',
      timestamp: '2026-11-10T10:00:01Z',
    });

    // Search scoped to default_user
    const userAResults = recallRepo.searchHistoricalExchanges({
      query: 'Project Chronos',
      userId: 'default_user',
    });
    assert.equal(userAResults.length, 1);
    assert.equal(userAResults[0]?.matchedMessage.sessionId, userASession);

    // Search scoped to user_bob
    const userBResults = recallRepo.searchHistoricalExchanges({
      query: 'Project Chronos',
      userId: 'user_bob',
    });
    assert.equal(userBResults.length, 1);
    assert.equal(userBResults[0]?.matchedMessage.sessionId, userBSession);

    // Search with non-existent user returns nothing
    const noResults = recallRepo.searchHistoricalExchanges({
      query: 'Project Chronos',
      userId: 'user_stranger',
    });
    assert.equal(noResults.length, 0);

    closeDatabase(db);
  });

  it('Neighboring conversation expansion: retrieves preceding and following turns', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);

    const sessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId,
      connectionId: 'conn-1',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });

    const m1Id = crypto.randomUUID();
    const m2Id = crypto.randomUUID();
    const m3Id = crypto.randomUUID();

    messageRepo.addMessage(sessionId, {
      id: m1Id,
      role: 'user',
      content: 'Can you show me a Fastify 5 plugin example?',
      timestamp: '2026-11-10T10:00:01Z',
    });
    messageRepo.addMessage(sessionId, {
      id: m2Id,
      role: 'assistant',
      content: 'Here is a Fastify plugin using export const plugin: FastifyPluginAsync = ...',
      timestamp: '2026-11-10T10:00:02Z',
    });
    messageRepo.addMessage(sessionId, {
      id: m3Id,
      role: 'user',
      content: 'Great, how do I register it in app.ts?',
      timestamp: '2026-11-10T10:00:03Z',
    });

    // Search matching m2 specifically
    const results = recallRepo.searchHistoricalExchanges({
      query: 'FastifyPluginAsync',
      neighborCount: 1,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.matchedMessage.id, m2Id);
    assert.equal(results[0]?.exchangeMessages.length, 3, 'Should include preceding, matched, and following messages');
    assert.equal(results[0]?.exchangeMessages[0]?.id, m1Id);
    assert.equal(results[0]?.exchangeMessages[1]?.id, m2Id);
    assert.equal(results[0]?.exchangeMessages[2]?.id, m3Id);

    closeDatabase(db);
  });

  it('Exchange deduplication: avoids duplicate exchanges when multiple messages match query', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);

    const sessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId,
      connectionId: 'conn-1',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });

    // Both messages contain "TypeScript" and "compiler"
    messageRepo.addMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'How does the TypeScript compiler tsc handle emitDeclarationOnly?',
      timestamp: '2026-11-10T10:00:01Z',
    });
    messageRepo.addMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'The TypeScript compiler generates .d.ts files without transpiling JS code.',
      timestamp: '2026-11-10T10:00:02Z',
    });

    const results = recallRepo.searchHistoricalExchanges({
      query: 'TypeScript compiler',
      limit: 5,
    });

    // Both messages matched in FTS, but deduplication should coalesce them into a single coherent exchange
    assert.equal(results.length, 1);
    assert.equal(results[0]?.exchangeMessages.length, 2);

    closeDatabase(db);
  });

  it('Query safety & tokenization: handles special characters, operators, and empty inputs cleanly', () => {
    // 1. Pure whitespace and empty queries return empty string
    assert.equal(tokenizeFts5Query(''), '');
    assert.equal(tokenizeFts5Query('     '), '');

    // 2. Pure punctuation returns empty string without crashing
    assert.equal(tokenizeFts5Query('!@#$%^&*()_+=~`{}[]|\\:;"<>,.?/'), '');

    // 3. Special SQLite FTS operators (AND, OR, NOT, *) are treated as literal tokens
    const operatorQuery = tokenizeFts5Query('SQLite AND OR NOT * ^ : test');
    assert.ok(operatorQuery.includes('"SQLite"'));
    assert.ok(operatorQuery.includes('"AND"'));
    assert.ok(operatorQuery.includes('"test"'));

    // 4. Quotes are safely escaped
    const quoteQuery = tokenizeFts5Query('He said "hello world"');
    assert.ok(quoteQuery.includes('"hello"'));
    assert.ok(quoteQuery.includes('"world"'));

    // 5. Test search with repository on dangerous input
    const { db } = initDatabase({ path: ':memory:' });
    const recallRepo = new RecallRepository(db);

    assert.doesNotThrow(() => {
      const res1 = recallRepo.searchHistoricalExchanges({ query: '' });
      assert.equal(res1.length, 0);

      const res2 = recallRepo.searchHistoricalExchanges({ query: '   ' });
      assert.equal(res2.length, 0);

      const res3 = recallRepo.searchHistoricalExchanges({ query: '!@#$%^&*()' });
      assert.equal(res3.length, 0);

      const res4 = recallRepo.searchHistoricalExchanges({ query: 'SELECT * FROM sessions WHERE 1=1; DROP TABLE messages;' });
      assert.ok(Array.isArray(res4));

      const res5 = recallRepo.searchHistoricalExchanges({ query: 'AND OR NOT NEAR/3' });
      assert.ok(Array.isArray(res5));
    });

    closeDatabase(db);
  });

  it('Ranking and result limits: orders by BM25 relevance score and respects limit', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);

    // Create 4 different sessions with varying frequency of query terms
    for (let i = 1; i <= 4; i++) {
      const sId = crypto.randomUUID();
      sessionRepo.createSession({
        sessionId: sId,
        connectionId: `conn-${i}`,
        createdAt: new Date(`2026-11-0${i}T10:00:00Z`),
        status: 'ended',
        userId: 'default_user',
      });

      // Session 1 matches all terms multiple times (highest relevance)
      const content =
        i === 1
          ? 'Kubernetes pods deployment service ingress horizontal pod autoscaler'
          : i === 2
          ? 'Kubernetes deployment service'
          : i === 3
          ? 'Kubernetes cluster'
          : 'Completely unrelated topic about gardening';

      messageRepo.addMessage(sId, {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: `2026-11-0${i}T10:00:01Z`,
      });
    }

    // Limit to 2 results
    const results = recallRepo.searchHistoricalExchanges({
      query: 'Kubernetes horizontal pod autoscaler ingress',
      limit: 2,
    });

    assert.equal(results.length, 2);
    // Highest ranked (lowest rank score in BM25) must be first
    assert.ok(results[0]!.rank <= results[1]!.rank, 'Results must be ordered by BM25 rank ascending');
    assert.ok(results[0]!.matchedMessage.content.includes('horizontal pod autoscaler'));

    closeDatabase(db);
  });

  it('Existing database compatibility: maintains existing records without corruption', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);

    const sId = crypto.randomUUID();
    const mId = crypto.randomUUID();

    sessionRepo.createSession({
      sessionId: sId,
      connectionId: 'conn-verify',
      createdAt: new Date('2026-11-13T12:00:00Z'),
      status: 'active',
      metadata: { env: 'production_test' },
    });

    messageRepo.addMessage(sId, {
      id: mId,
      role: 'user',
      content: 'Verifying database integrity across recall operations.',
      timestamp: '2026-11-13T12:00:01Z',
    });

    // Check session retrieval
    const loadedSession = sessionRepo.getSession(sId);
    assert.ok(loadedSession);
    assert.equal(loadedSession.sessionId, sId);
    assert.equal(loadedSession.status, 'active');
    assert.equal(loadedSession.userId, 'default_user');
    assert.deepEqual(loadedSession.metadata, { env: 'production_test' });

    // Check message retrieval
    const messages = messageRepo.getMessagesBySessionId(sId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.id, mId);
    assert.equal(messages[0]?.content, 'Verifying database integrity across recall operations.');

    closeDatabase(db);
  });
});

