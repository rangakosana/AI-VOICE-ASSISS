import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import {
  createDatabaseConnection,
  initDatabase,
  getDatabase,
  closeDatabase,
  MessageRepository,
  SessionRepository,
} from '../src/db/index.js';
import { ConversationHistoryManager } from '../src/services/ai/conversationHistory.js';
import { SessionRegistry, sessionRegistry } from '../src/services/sessionRegistry.js';
import { ConversationEngine, conversationEngine } from '../src/services/ai/conversationEngine.js';
import { MockAIProvider } from '../src/services/ai/mockProvider.js';
import { buildApp } from '../src/app.js';
import type { ChatMessage } from '../src/services/ai/types.js';

interface TestClient {
  ws: WebSocket;
  nextMessage: <T = Record<string, unknown>>(timeoutMs?: number) => Promise<T>;
  send: (msg: unknown) => void;
  close: () => void;
}

async function createClient(app: ReturnType<typeof buildApp>): Promise<TestClient> {
  const queue: unknown[] = [];
  let waiter: ((msg: unknown) => void) | null = null;
  let waiterTimeout: NodeJS.Timeout | null = null;

  const ws = await app.injectWS('/v1/realtime', {}, {
    onOpen: (client) => {
      client.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          parsed = data.toString();
        }

        if (waiter) {
          if (waiterTimeout) clearTimeout(waiterTimeout);
          const resolve = waiter;
          waiter = null;
          resolve(parsed);
        } else {
          queue.push(parsed);
        }
      });
    },
  });

  return {
    ws,
    nextMessage: <T>(timeoutMs = 2000): Promise<T> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift() as T);
      }
      return new Promise<T>((resolve, reject) => {
        waiterTimeout = setTimeout(() => {
          waiter = null;
          reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
        }, timeoutMs);
        waiter = (msg) => resolve(msg as T);
      });
    },
    send: (msg: unknown) => {
      const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
      ws.send(payload);
    },
    close: () => {
      if (waiterTimeout) clearTimeout(waiterTimeout);
      ws.terminate();
    },
  };
}

describe('Persistent Conversation Storage Tests (Milestone 6B)', () => {
  it('MessageRepository: supports insertion, retrieval, and fields fidelity', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MessageRepository(db);

    const msg1: ChatMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello Atlas',
      timestamp: '2026-11-13T10:00:00.000Z',
    };

    const msg2: ChatMessage = {
      id: 'msg-2',
      role: 'assistant',
      content: 'Hello! How can I help you?',
      timestamp: '2026-11-13T10:00:01.000Z',
    };

    repo.addMessage('sess-1', msg1);
    repo.addMessage('sess-1', msg2);

    const history = repo.getMessagesBySessionId('sess-1');
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], msg1);
    assert.deepEqual(history[1], msg2);

    closeDatabase(db);
  });

  it('MessageRepository: retrieves messages in strict chronological order', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MessageRepository(db);

    // Insert 5 turns with sequential content
    for (let i = 1; i <= 5; i++) {
      repo.addMessage('sess-ordered', {
        id: `msg-${i}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Content ${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      });
    }

    const history = repo.getMessagesBySessionId('sess-ordered');
    assert.equal(history.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(history[i]?.content, `Content ${i + 1}`);
      assert.equal(history[i]?.id, `msg-${i + 1}`);
    }

    closeDatabase(db);
  });

  it('MessageRepository: removes specific message and updates message counts', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MessageRepository(db);

    repo.addMessage('sess-remove', {
      id: 'm1',
      role: 'user',
      content: 'First',
      timestamp: new Date().toISOString(),
    });
    repo.addMessage('sess-remove', {
      id: 'm2',
      role: 'user',
      content: 'Incomplete prompt to remove',
      timestamp: new Date().toISOString(),
    });
    repo.addMessage('sess-remove', {
      id: 'm3',
      role: 'assistant',
      content: 'Third',
      timestamp: new Date().toISOString(),
    });

    assert.equal(repo.countMessages('sess-remove'), 3);

    // Remove m2
    const removed = repo.removeMessage('sess-remove', 'm2');
    assert.equal(removed, true);
    assert.equal(repo.countMessages('sess-remove'), 2);

    const history = repo.getMessagesBySessionId('sess-remove');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.id, 'm1');
    assert.equal(history[1]?.id, 'm3');

    // Attempting to remove non-existent message returns false
    const removedNonExistent = repo.removeMessage('sess-remove', 'unknown-id');
    assert.equal(removedNonExistent, false);

    closeDatabase(db);
  });

  it('MessageRepository: clears messages scoped to session without affecting others', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new MessageRepository(db);

    repo.addMessage('sess-a', { id: 'a1', role: 'user', content: 'Session A', timestamp: 't1' });
    repo.addMessage('sess-b', { id: 'b1', role: 'user', content: 'Session B', timestamp: 't2' });

    assert.equal(repo.countMessages('sess-a'), 1);
    assert.equal(repo.countMessages('sess-b'), 1);

    repo.clearMessagesBySessionId('sess-a');
    assert.equal(repo.countMessages('sess-a'), 0);
    assert.equal(repo.countMessages('sess-b'), 1, 'Session B must remain untouched');
    assert.equal(repo.getMessagesBySessionId('sess-b')[0]?.content, 'Session B');

    closeDatabase(db);
  });

  it('SessionRepository: creates, retrieves, and terminates persistent sessions', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new SessionRepository(db);

    const session = {
      sessionId: 'sess-persisted-1',
      connectionId: 'conn-1',
      createdAt: new Date('2026-11-13T10:00:00.000Z'),
      status: 'active' as const,
      metadata: { client: 'android', version: '1.0' },
    };

    repo.createSession(session);

    const retrieved = repo.getSession('sess-persisted-1');
    assert.ok(retrieved);
    assert.equal(retrieved.sessionId, 'sess-persisted-1');
    assert.equal(retrieved.connectionId, 'conn-1');
    assert.equal(retrieved.status, 'active');
    assert.deepEqual(retrieved.metadata, { client: 'android', version: '1.0' });

    // End session
    const endedAt = new Date('2026-11-13T10:05:00.000Z');
    const ended = repo.endSession('sess-persisted-1', endedAt, { client: 'android', endReason: 'client_done' });
    assert.equal(ended, true);

    const retrievedEnded = repo.getSession('sess-persisted-1');
    assert.ok(retrievedEnded);
    assert.equal(retrievedEnded.status, 'ended');
    assert.equal(retrievedEnded.endedAt?.toISOString(), endedAt.toISOString());
    assert.equal(retrievedEnded.metadata?.endReason, 'client_done');

    closeDatabase(db);
  });

  it('SessionRepository: marks dangling active sessions as ended on startup', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const repo = new SessionRepository(db);

    repo.createSession({
      sessionId: 'sess-dangling-1',
      connectionId: 'old-conn-1',
      createdAt: new Date(),
      status: 'active',
    });
    repo.createSession({
      sessionId: 'sess-dangling-2',
      connectionId: 'old-conn-2',
      createdAt: new Date(),
      status: 'active',
    });

    const changed = repo.markDanglingSessionsEndedOnStartup();
    assert.equal(changed, 2);

    assert.equal(repo.getSession('sess-dangling-1')?.status, 'ended');
    assert.equal(repo.getSession('sess-dangling-2')?.status, 'ended');

    closeDatabase(db);
  });

  it('Persists data across database connection close and reopen on disk', () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const diskPath = path.resolve(currentDir, '../data/test-persistence.db');

    // Clean any previous file
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);

    // 1. Open disk database and write data
    const db1 = createDatabaseConnection({ path: diskPath });
    initDatabase({ path: diskPath }); // ensures migrations run
    const sessionRepo1 = new SessionRepository(db1);
    const messageRepo1 = new MessageRepository(db1);

    sessionRepo1.createSession({
      sessionId: 'sess-disk',
      connectionId: 'conn-disk-1',
      createdAt: new Date('2026-11-13T10:00:00.000Z'),
      status: 'active',
      metadata: { persistent: true },
    });

    messageRepo1.addMessage('sess-disk', {
      id: 'm-disk-1',
      role: 'user',
      content: 'Persisted to disk across process restarts',
      timestamp: '2026-11-13T10:01:00.000Z',
    });

    closeDatabase(db1);

    // 2. Reopen from the exact same disk file
    const db2 = createDatabaseConnection({ path: diskPath });
    const sessionRepo2 = new SessionRepository(db2);
    const messageRepo2 = new MessageRepository(db2);

    const reloadedSession = sessionRepo2.getSession('sess-disk');
    assert.ok(reloadedSession);
    assert.equal(reloadedSession.sessionId, 'sess-disk');
    assert.equal(reloadedSession.status, 'active');

    const reloadedMessages = messageRepo2.getMessagesBySessionId('sess-disk');
    assert.equal(reloadedMessages.length, 1);
    assert.equal(reloadedMessages[0]?.id, 'm-disk-1');
    assert.equal(reloadedMessages[0]?.content, 'Persisted to disk across process restarts');

    closeDatabase(db2);

    // Cleanup disk test files
    try {
      if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
      const wal = `${diskPath}-wal`;
      const shm = `${diskPath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch {
      // Ignore
    }
  });

  it('ConversationEngine + SQLite ConversationHistoryManager: persists turns and rolls back on cancellation', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const historyManager = new ConversationHistoryManager({ db });
    const mockProvider = new MockAIProvider({ chunkDelayMs: 25 });
    const engine = new ConversationEngine({
      defaultProvider: mockProvider,
      historyManager,
    });

    // Turn 1: Completes normally
    let turn1Text = '';
    await engine.processUserMessage('sess-engine', 'First prompt', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (full) => {
        turn1Text = full;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(turn1Text.includes('First prompt'));
    const historyAfterTurn1 = historyManager.getHistory('sess-engine');
    assert.equal(historyAfterTurn1.length, 2);
    assert.equal(historyAfterTurn1[0]?.content, 'First prompt');
    assert.equal(historyAfterTurn1[1]?.role, 'assistant');

    // Turn 2: Cancelled mid-stream
    let cancelled = false;
    const cancelPromise = engine.processUserMessage('sess-engine', 'Will be cancelled', {
      onStart: () => {},
      onDelta: () => {
        engine.cancelGeneration('sess-engine');
      },
      onComplete: () => assert.fail('Should not complete cancelled turn'),
      onCancelled: () => {
        cancelled = true;
      },
      onError: (err) => assert.fail(err.message),
    });

    await cancelPromise;
    assert.ok(cancelled);

    // Verify turn 2's user prompt was cleanly rolled back from SQLite
    const historyAfterCancel = historyManager.getHistory('sess-engine');
    assert.equal(historyAfterCancel.length, 2, 'Cancelled turn must be rolled back from SQLite');
    assert.equal(historyAfterCancel[0]?.content, 'First prompt');
    assert.equal(historyAfterCancel[1]?.role, 'assistant');

    // Turn 3: Subsequent turn runs cleanly
    let turn3Text = '';
    await engine.processUserMessage('sess-engine', 'Next valid prompt', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (full) => {
        turn3Text = full;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(turn3Text.includes('Turn 3'));
    const finalHistory = historyManager.getHistory('sess-engine');
    assert.equal(finalHistory.length, 4, 'Must have 4 messages: Turn 1 (user+assistant) + Turn 3 (user+assistant)');
    assert.equal(finalHistory[2]?.content, 'Next valid prompt');

    closeDatabase(db);
  });

  it('SessionRegistry: bridges in-memory live sockets with SQLite persistence', () => {
    const { db } = initDatabase({ path: ':memory:' });
    const sessionRepo = new SessionRepository(db);
    const registry = new SessionRegistry({ repository: sessionRepo });

    const session = registry.createSession('conn-live-1', { app: 'test' });
    assert.ok(session);
    assert.equal(session.status, 'active');
    assert.equal(registry.getActiveSessionCount(), 1);

    // Verify persisted in SQLite
    const inDb = sessionRepo.getSession(session.sessionId);
    assert.ok(inDb);
    assert.equal(inDb.status, 'active');

    // End session via registry
    const ended = registry.endSession(session.sessionId, 'user_logout');
    assert.ok(ended);
    assert.equal(ended.status, 'ended');
    assert.equal(registry.getActiveSessionCount(), 0);

    // Verify updated in SQLite
    const inDbEnded = sessionRepo.getSession(session.sessionId);
    assert.ok(inDbEnded);
    assert.equal(inDbEnded.status, 'ended');
    assert.equal(inDbEnded.metadata?.endReason, 'user_logout');

    closeDatabase(db);
  });

  it('End-to-End WebSocket with SQLite storage: verifies database records after WebSocket interactions', async () => {
    sessionRegistry.clear();
    conversationEngine.clear();

    const db = getDatabase();
    const app = buildApp({ logger: false, skipDb: true });
    await app.ready();

    const client = await createClient(app);

    // 1. Ready
    const readyMsg = await client.nextMessage();
    assert.equal(readyMsg.type, 'server.ready');

    // 2. Start Session
    client.send({
      type: 'client.session.start',
      requestId: 'req-start-db',
      timestamp: new Date().toISOString(),
      payload: { clientName: 'SQLite-Tester' },
    });
    const sessionStarted = await client.nextMessage<{ type: string; payload: { sessionId: string } }>();
    assert.equal(sessionStarted.type, 'server.session.started');
    const sessionId = sessionStarted.payload.sessionId;

    // Verify session persisted in SQLite
    const sessionRepo = new SessionRepository(db);
    const dbSession = sessionRepo.getSession(sessionId);
    assert.ok(dbSession);
    assert.equal(dbSession.status, 'active');

    // 3. Send message
    client.send({
      type: 'client.message.send',
      requestId: 'req-msg-db',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Testing SQLite persistence end-to-end' },
    });

    // Consume WebSocket events: accepted, started, deltas, completed
    const accepted = await client.nextMessage();
    assert.equal(accepted.type, 'server.message.accepted');
    const started = await client.nextMessage();
    assert.equal(started.type, 'server.response.started');

    let completedMsg: { type: string; payload?: { text?: string } } | undefined;
    while (!completedMsg) {
      const msg = await client.nextMessage<{ type: string; payload?: { text?: string } }>();
      if (msg.type === 'server.response.completed') {
        completedMsg = msg;
      }
    }

    assert.equal(completedMsg.type, 'server.response.completed');

    // Verify messages persisted in SQLite
    const messageRepo = new MessageRepository(db);
    const storedMessages = messageRepo.getMessagesBySessionId(sessionId);
    assert.equal(storedMessages.length, 2, 'User prompt and assistant response must be persisted in SQLite');
    assert.equal(storedMessages[0]?.role, 'user');
    assert.equal(storedMessages[0]?.content, 'Testing SQLite persistence end-to-end');
    assert.equal(storedMessages[1]?.role, 'assistant');

    // 4. End Session
    client.send({
      type: 'client.session.end',
      requestId: 'req-end-db',
      sessionId,
      timestamp: new Date().toISOString(),
    });
    const endedMsg = await client.nextMessage();
    assert.equal(endedMsg.type, 'server.session.ended');

    // Verify session status updated to ended in SQLite
    const updatedDbSession = sessionRepo.getSession(sessionId);
    assert.ok(updatedDbSession);
    assert.equal(updatedDbSession.status, 'ended');

    client.close();
    await app.close();
  });
});
