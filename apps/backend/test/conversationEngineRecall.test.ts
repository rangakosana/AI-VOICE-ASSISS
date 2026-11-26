import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  initDatabase,
  closeDatabase,
  MemoryRepository,
  MessageRepository,
  SessionRepository,
  RecallRepository,
} from '../src/db/index.js';
import { MemoryService } from '../src/services/memory/memoryService.js';
import { RecallService } from '../src/services/recall/recallService.js';
import { ConversationHistoryManager } from '../src/services/ai/conversationHistory.js';
import { ConversationEngine } from '../src/services/ai/conversationEngine.js';
import type {
  AIProvider,
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  StreamChunk,
  StreamOptions,
} from '../src/services/ai/types.js';

/**
 * Spy AI provider that records the exact messages array it receives for streaming
 */
class SpyAIProvider implements AIProvider {
  readonly name = 'spy-provider';
  readonly version = '1.0.0';
  lastReceivedMessages: readonly ChatMessage[] = [];

  async generateResponse(options: GenerateOptions): Promise<GenerateResult> {
    this.lastReceivedMessages = [...options.messages];
    return { text: 'Spy response' };
  }

  async *streamResponse(options: StreamOptions): AsyncIterable<StreamChunk> {
    this.lastReceivedMessages = [...options.messages];
    yield { text: 'Spy response chunk', index: 0, isFinal: true };
  }
}

describe('ConversationEngine Ephemeral Recall Integration Tests (Milestone 7C.3)', () => {
  it('1 & 2. RecallService is called with current user message and excludes current session ID', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    // 1. Create a historical session with discussion about Fastify plugins
    const oldSessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: oldSessionId,
      connectionId: 'conn-old',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
      userId: 'default_user',
    });
    messageRepo.addMessage(oldSessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'How do I structure Fastify plugins in TypeScript?',
      timestamp: '2026-11-10T10:00:01Z',
    });
    messageRepo.addMessage(oldSessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Use export const plugin: FastifyPluginAsync with fastify-plugin wrapper.',
      timestamp: '2026-11-10T10:00:02Z',
    });

    // 2. Active session
    const currentSessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: currentSessionId,
      connectionId: 'conn-active',
      createdAt: new Date('2026-11-13T10:00:00Z'),
      status: 'active',
      userId: 'default_user',
    });

    let capturedQuery = '';
    let capturedExcludeSession = '';

    const recallService = new RecallService({ repository: recallRepo });
    const originalBuild = recallService.buildRecallPromptContext.bind(recallService);
    recallService.buildRecallPromptContext = (opts) => {
      capturedQuery = opts.query;
      capturedExcludeSession = opts.currentSessionId ?? '';
      return originalBuild(opts);
    };

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      recallService,
      memoryService: undefined,
    });

    await engine.processUserMessage(
      currentSessionId,
      'Can you remind me how we configured Fastify plugins in our previous discussion?',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {},
        onCancelled: () => {},
        onError: (err) => {
          throw err;
        },
      }
    );

    // Verify recall was invoked with exact user message
    assert.equal(
      capturedQuery,
      'Can you remind me how we configured Fastify plugins in our previous discussion?'
    );
    // Verify current session was passed for exclusion
    assert.equal(capturedExcludeSession, currentSessionId);

    // Verify spy received ephemeral recall context
    assert.equal(spyProvider.lastReceivedMessages.length, 2);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'system');
    assert.equal(spyProvider.lastReceivedMessages[0]?.id, 'ephemeral-recall-context');
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('[RELEVANT PAST CONVERSATIONS & HISTORICAL CONTEXT]'));
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('FastifyPluginAsync'));

    closeDatabase(db);
  });

  it('3. Trusted internal user ID is passed to RecallService', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    let capturedUserId: string | undefined;

    const recallService = new RecallService({ repository: recallRepo });
    recallService.buildRecallPromptContext = (opts) => {
      capturedUserId = opts.userId;
      return undefined;
    };

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      recallService,
      memoryService: undefined,
    });

    await engine.processUserMessage(
      'session-trusted-user',
      'What was my previous plan?',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {},
        onCancelled: () => {},
        onError: (err) => {
          throw err;
        },
      },
      { userId: 'alice_trusted' }
    );

    assert.equal(capturedUserId, 'alice_trusted');

    closeDatabase(db);
  });

  it('4 & 5. Personal Memory and historical recall are both included in correct context order', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const memoryService = new MemoryService({ repository: memoryRepo });
    const recallService = new RecallService({ repository: recallRepo });

    // Setup active memory
    memoryService.saveMemory({
      category: 'preference',
      content: 'Prefers concise, actionable code examples',
    });

    // Setup past session with Docker discussion
    const pastSessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: pastSessionId,
      connectionId: 'conn-docker',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
    });
    messageRepo.addMessage(pastSessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'How do I run a local Redis container with Docker?',
      timestamp: '2026-11-10T10:00:01Z',
    });
    messageRepo.addMessage(pastSessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Run docker run -d --name redis-local -p 6379:6379 redis:alpine.',
      timestamp: '2026-11-10T10:00:02Z',
    });

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
      recallService,
    });

    const currentSessionId = crypto.randomUUID();
    await engine.processUserMessage(
      currentSessionId,
      'What command did we use for running the Redis Docker container?',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {},
        onCancelled: () => {},
        onError: (err) => {
          throw err;
        },
      }
    );

    // Verify spy received 3 messages in exact order:
    // 1. Personal Memory (ephemeral-memory-context)
    // 2. Historical Recall (ephemeral-recall-context)
    // 3. User message
    assert.equal(spyProvider.lastReceivedMessages.length, 3);

    // Block 1: Personal Memory
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'system');
    assert.equal(spyProvider.lastReceivedMessages[0]?.id, 'ephemeral-memory-context');
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('[USER PERSONAL KNOWLEDGE & CONTEXT]'));
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('Prefers concise, actionable code examples'));

    // Block 2: Historical Recall
    assert.equal(spyProvider.lastReceivedMessages[1]?.role, 'system');
    assert.equal(spyProvider.lastReceivedMessages[1]?.id, 'ephemeral-recall-context');
    assert.ok(spyProvider.lastReceivedMessages[1]?.content.includes('[RELEVANT PAST CONVERSATIONS & HISTORICAL CONTEXT]'));
    assert.ok(spyProvider.lastReceivedMessages[1]?.content.includes('redis:alpine'));

    // Block 3: User message
    assert.equal(spyProvider.lastReceivedMessages[2]?.role, 'user');
    assert.equal(
      spyProvider.lastReceivedMessages[2]?.content,
      'What command did we use for running the Redis Docker container?'
    );

    closeDatabase(db);
  });

  it('6. No historical matches means normal conversation continues without recall block', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const recallService = new RecallService({ repository: recallRepo });
    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      recallService,
      memoryService: undefined,
    });

    await engine.processUserMessage('session-empty-match', 'hello', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // "hello" is generic, so no recall block is added
    assert.equal(spyProvider.lastReceivedMessages.length, 1);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'user');
    assert.equal(spyProvider.lastReceivedMessages[0]?.content, 'hello');

    closeDatabase(db);
  });

  it('7. Undefined personal memory does not break recall', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    // Past session
    const oldSessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: oldSessionId,
      connectionId: 'conn-old',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
    });
    messageRepo.addMessage(oldSessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Kubernetes ingress controller configuration for TLS termination.',
      timestamp: '2026-11-10T10:00:01Z',
    });

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService: undefined, // no memory service
      recallService: new RecallService({ repository: recallRepo }),
    });

    await engine.processUserMessage(
      'current-session',
      'Kubernetes ingress TLS termination',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {},
        onCancelled: () => {},
        onError: (err) => {
          throw err;
        },
      }
    );

    // Only recall context + user message
    assert.equal(spyProvider.lastReceivedMessages.length, 2);
    assert.equal(spyProvider.lastReceivedMessages[0]?.id, 'ephemeral-recall-context');
    assert.equal(spyProvider.lastReceivedMessages[1]?.role, 'user');

    closeDatabase(db);
  });

  it('8. Undefined recall does not break personal memory', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const memoryService = new MemoryService({ repository: memoryRepo });
    memoryService.saveMemory({
      category: 'personal_fact',
      content: 'User is a senior backend systems engineer',
    });

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
      recallService: undefined, // no recall service
    });

    await engine.processUserMessage('current-session', 'hello', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // Only memory context + user message
    assert.equal(spyProvider.lastReceivedMessages.length, 2);
    assert.equal(spyProvider.lastReceivedMessages[0]?.id, 'ephemeral-memory-context');
    assert.equal(spyProvider.lastReceivedMessages[1]?.role, 'user');

    closeDatabase(db);
  });

  it('9. Recall context is NEVER persisted in SQLite conversation history', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const sessionRepo = new SessionRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    // Past session
    const oldSessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId: oldSessionId,
      connectionId: 'conn-past',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      status: 'ended',
    });
    messageRepo.addMessage(oldSessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Past discussion on Kafka event partitioning keys.',
      timestamp: '2026-11-10T10:00:01Z',
    });

    const currentSessionId = crypto.randomUUID();
    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      recallService: new RecallService({ repository: recallRepo }),
      memoryService: undefined,
    });

    await engine.processUserMessage(
      currentSessionId,
      'Tell me about Kafka event partitioning keys',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {},
        onCancelled: () => {},
        onError: (err) => {
          throw err;
        },
      }
    );

    // Verify spy received ephemeral recall context
    assert.equal(spyProvider.lastReceivedMessages[0]?.id, 'ephemeral-recall-context');

    // Verify persistent history in SQLite only contains the 2 actual turns: user and assistant
    const storedMessages = messageRepo.getMessagesBySessionId(currentSessionId);
    assert.equal(storedMessages.length, 2);
    assert.equal(storedMessages[0]?.role, 'user');
    assert.equal(storedMessages[0]?.content, 'Tell me about Kafka event partitioning keys');
    assert.equal(storedMessages[1]?.role, 'assistant');
    assert.equal(storedMessages[1]?.content, 'Spy response chunk');

    // Confirm neither 'ephemeral-recall-context' nor '[RELEVANT PAST CONVERSATIONS' exists in DB
    const dbRows = db
      .prepare('SELECT * FROM messages WHERE session_id = ?')
      .all(currentSessionId) as Array<{ role: string; content: string }>;
    assert.ok(dbRows.every((r) => r.role !== 'system'));
    assert.ok(dbRows.every((r) => !r.content.includes('[RELEVANT PAST CONVERSATIONS')));

    closeDatabase(db);
  });

  it('10. Cancellation rolls back incomplete turn cleanly', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });

    // Slow provider to facilitate cancellation during streaming
    class SlowProvider implements AIProvider {
      readonly name = 'slow-provider';
      readonly version = '1.0.0';
      async generateResponse(): Promise<GenerateResult> {
        return { text: 'Slow' };
      }
      async *streamResponse(options: StreamOptions): AsyncIterable<StreamChunk> {
        for (let i = 0; i < 5; i++) {
          if (options.signal?.aborted) {
            const err = new Error('cancelled');
            err.name = 'AbortError';
            throw err;
          }
          await new Promise((res) => setTimeout(res, 20));
          yield { text: `chunk-${i}`, index: i, isFinal: i === 4 };
        }
      }
    }

    const sessionId = crypto.randomUUID();
    const engine = new ConversationEngine({
      defaultProvider: new SlowProvider(),
      historyManager,
      recallService: new RecallService({ repository: recallRepo }),
      memoryService: undefined,
    });

    let wasCancelled = false;
    const promise = engine.processUserMessage(
      sessionId,
      'This generation will be aborted midway',
      {
        onStart: () => {},
        onDelta: (_chunk, index) => {
          if (index === 1) {
            engine.cancelGeneration(sessionId);
          }
        },
        onComplete: () => {
          assert.fail('Should not complete when cancelled');
        },
        onCancelled: () => {
          wasCancelled = true;
        },
        onError: (err) => {
          assert.fail(`Unexpected error: ${err.message}`);
        },
      }
    );

    await promise;

    assert.equal(wasCancelled, true);
    // User message must be rolled back from history
    assert.equal(historyManager.getMessageCount(sessionId), 0);
    assert.equal(messageRepo.countMessages(sessionId), 0);

    closeDatabase(db);
  });

  it('11. Recall failure rolls back incomplete turn and calls onError', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    // Mock recall service that fails during prompt context building
    const failingRecallService = {
      buildRecallPromptContext: () => {
        throw new Error('Disk corruption during FTS recall index read');
      },
    } as unknown as RecallService;

    const sessionId = crypto.randomUUID();
    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      recallService: failingRecallService,
      memoryService: undefined,
    });

    let caughtError: Error | undefined;

    await engine.processUserMessage(
      sessionId,
      'Query that triggers recall failure',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {
          assert.fail('Should not complete on recall error');
        },
        onCancelled: () => {
          assert.fail('Should not call onCancelled on recall error');
        },
        onError: (err) => {
          caughtError = err;
        },
      }
    );

    assert.ok(caughtError);
    assert.equal(caughtError.message, 'Disk corruption during FTS recall index read');

    // Verify turn was rolled back and database has 0 messages
    assert.equal(historyManager.getMessageCount(sessionId), 0);
    assert.equal(messageRepo.countMessages(sessionId), 0);

    // Verify provider was never called
    assert.equal(spyProvider.lastReceivedMessages.length, 0);

    closeDatabase(db);
  });

  it('12. Existing session isolation remains completely intact', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const messageRepo = new MessageRepository(db);
    const recallRepo = new RecallRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      recallService: new RecallService({ repository: recallRepo }),
      memoryService: undefined,
    });

    const sessionA = 'session-isolation-A';
    const sessionB = 'session-isolation-B';

    await engine.processUserMessage(sessionA, 'Message in Session A', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    await engine.processUserMessage(sessionB, 'Message in Session B', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    const messagesA = historyManager.getHistory(sessionA);
    const messagesB = historyManager.getHistory(sessionB);

    assert.equal(messagesA.length, 2);
    assert.equal(messagesA[0]?.content, 'Message in Session A');

    assert.equal(messagesB.length, 2);
    assert.equal(messagesB[0]?.content, 'Message in Session B');

    closeDatabase(db);
  });
});

