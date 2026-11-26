import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDatabase,
  closeDatabase,
  MemoryRepository,
  MessageRepository,
} from '../src/db/index.js';
import { MemoryService } from '../src/services/memory/memoryService.js';
import { ConversationHistoryManager } from '../src/services/ai/conversationHistory.js';
import { ConversationEngine } from '../src/services/ai/conversationEngine.js';
import { MockAIProvider } from '../src/services/ai/mockProvider.js';
import type {
  AIProvider,
  GenerateOptions,
  GenerateResult,
  StreamChunk,
  StreamOptions,
  ChatMessage,
} from '../src/services/ai/types.js';

/**
 * Test AI provider that records the exact messages array it receives
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
    yield { text: 'Spy response stream', index: 0, isFinal: true };
  }
}

describe('ConversationEngine Ephemeral Memory Integration Tests (Milestone 7B.3)', () => {
  it('1. Active memories reach the provider as an ephemeral system message', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    // Save an active preference
    memoryService.saveMemory({
      category: 'preference',
      content: 'Prefers concise voice responses',
    });

    let completedText = '';
    await engine.processUserMessage('session-1', 'Hello Atlas', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        completedText = text;
      },
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    assert.equal(completedText, 'Spy response stream');

    // Verify spy received 2 messages: 1 ephemeral system message + 1 user message
    assert.equal(spyProvider.lastReceivedMessages.length, 2);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'system');
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('Prefers concise voice responses'));
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('[USER PERSONAL KNOWLEDGE & CONTEXT]'));

    assert.equal(spyProvider.lastReceivedMessages[1]?.role, 'user');
    assert.equal(spyProvider.lastReceivedMessages[1]?.content, 'Hello Atlas');

    closeDatabase(db);
  });

  it('2. Suggested, archived, and deleted memories never reach the provider', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    // Suggested memory
    memoryService.saveMemory({
      category: 'goal',
      content: 'Pending suggestion to study Rust',
      source: 'assistant_suggested',
    });

    // Archived memory
    memoryService.saveMemory({
      category: 'context',
      content: 'Old archived context',
      status: 'archived',
    });

    // Deleted memory
    const active = memoryService.saveMemory({
      category: 'personal_fact',
      content: 'Deleted fact',
    });
    memoryService.deleteMemory(active.id);

    await engine.processUserMessage('session-2', 'How are you?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // Since no active memories exist, provider receives ONLY the user turn
    assert.equal(spyProvider.lastReceivedMessages.length, 1);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'user');
    assert.equal(spyProvider.lastReceivedMessages[0]?.content, 'How are you?');

    closeDatabase(db);
  });

  it('3. No memory context is added when no active memories exist', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    await engine.processUserMessage('session-3', 'Test zero memories', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    assert.equal(spyProvider.lastReceivedMessages.length, 1);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'user');

    closeDatabase(db);
  });

  it('4. Memory context is NEVER persisted in SQLite conversation history', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    memoryService.saveMemory({
      category: 'preference',
      content: 'Prefers TypeScript',
    });

    await engine.processUserMessage('session-persistent-check', 'Persistent check prompt', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // Provider received the ephemeral system message
    assert.equal(spyProvider.lastReceivedMessages.length, 2);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'system');

    // Inspect SQLite conversation history directly
    const storedHistory = historyManager.getHistory('session-persistent-check');
    assert.equal(storedHistory.length, 2, 'History must contain strictly 2 messages: user turn and assistant reply');
    assert.equal(storedHistory[0]?.role, 'user');
    assert.equal(storedHistory[0]?.content, 'Persistent check prompt');
    assert.equal(storedHistory[1]?.role, 'assistant');
    assert.equal(storedHistory[1]?.content, 'Spy response stream');

    // Confirm NO system message exists in persistent storage
    const hasSystemMessage = storedHistory.some((m) => m.role === 'system');
    assert.equal(hasSystemMessage, false, 'Memory context must never be saved to SQLite messages table');

    // Confirm memory text does not appear in user/assistant content
    assert.equal(storedHistory[0]?.content.includes('Prefers TypeScript'), false);
    assert.equal(storedHistory[1]?.content.includes('Prefers TypeScript'), false);

    closeDatabase(db);
  });

  it('5. Memory updates are reflected immediately in subsequent turns without session restart', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    // Initial memory state
    const pref = memoryService.saveMemory({
      category: 'preference',
      content: 'Initial preference: dark mode',
    });

    // Turn 1
    await engine.processUserMessage('session-update-turn', 'Turn 1 prompt', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('Initial preference: dark mode'));

    // Update memory before Turn 2
    memoryService.updateMemory(pref.id, {
      content: 'Updated preference: light mode',
    });

    // Turn 2 in same session
    await engine.processUserMessage('session-update-turn', 'Turn 2 prompt', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // Provider on Turn 2 receives updated preference
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('Updated preference: light mode'));
    assert.equal(spyProvider.lastReceivedMessages[0]?.content.includes('Initial preference: dark mode'), false);

    closeDatabase(db);
  });

  it('6. Different user profiles cannot see each others memories', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    // Alice's memory
    memoryService.saveMemory({ category: 'personal_fact', content: 'Alice loves jazz' }, 'alice');
    // Bob's memory
    memoryService.saveMemory({ category: 'personal_fact', content: 'Bob loves rock' }, 'bob');

    // Turn for Alice
    await engine.processUserMessage(
      'session-alice',
      'Prompt for Alice',
      { onStart: () => {}, onDelta: () => {}, onComplete: () => {}, onCancelled: () => {}, onError: (e) => { throw e; } },
      { userId: 'alice' }
    );
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('Alice loves jazz'));
    assert.equal(spyProvider.lastReceivedMessages[0]?.content.includes('Bob loves rock'), false);

    // Turn for Bob
    await engine.processUserMessage(
      'session-bob',
      'Prompt for Bob',
      { onStart: () => {}, onDelta: () => {}, onComplete: () => {}, onCancelled: () => {}, onError: (e) => { throw e; } },
      { userId: 'bob' }
    );
    assert.ok(spyProvider.lastReceivedMessages[0]?.content.includes('Bob loves rock'));
    assert.equal(spyProvider.lastReceivedMessages[0]?.content.includes('Alice loves jazz'), false);

    closeDatabase(db);
  });

  it('7. Cancellation rolls back incomplete turn without affecting memories', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const mockProvider = new MockAIProvider({ chunkDelayMs: 30 });

    const engine = new ConversationEngine({
      defaultProvider: mockProvider,
      historyManager,
      memoryService,
    });

    // Active memory
    const mem = memoryService.saveMemory({
      category: 'goal',
      content: 'Pass AWS exam',
    });

    let wasCancelled = false;
    const processPromise = engine.processUserMessage('session-cancel', 'Will be cancelled', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {
        wasCancelled = true;
      },
      onError: (err) => {
        throw err;
      },
    });

    // Cancel mid-stream
    await new Promise((r) => setTimeout(r, 10));
    engine.cancelGeneration('session-cancel');
    await processPromise;

    assert.equal(wasCancelled, true);

    // User turn must be rolled back from SQLite
    assert.equal(historyManager.getHistory('session-cancel').length, 0);

    // Memory in MemoryService must remain intact and active
    const reloadedMem = memoryService.getMemory(mem.id);
    assert.ok(reloadedMem);
    assert.equal(reloadedMem.status, 'active');
    assert.equal(reloadedMem.content, 'Pass AWS exam');

    closeDatabase(db);
  });

  it('8. Existing conversation continuity remains unchanged across multi-turn sessions', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const memoryService = new MemoryService({ repository: memoryRepo });
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService,
    });

    memoryService.saveMemory({
      category: 'personal_fact',
      content: 'Lives in Hyderabad',
    });

    // Turn 1
    await engine.processUserMessage('session-continuity', 'Turn 1 User', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (e) => { throw e; },
    });

    // Turn 2
    await engine.processUserMessage('session-continuity', 'Turn 2 User', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (e) => { throw e; },
    });

    // History contains Turn 1 user, Turn 1 assistant, Turn 2 user, Turn 2 assistant = 4 messages
    const history = historyManager.getHistory('session-continuity');
    assert.equal(history.length, 4);
    assert.equal(history[0]?.content, 'Turn 1 User');
    assert.equal(history[1]?.content, 'Spy response stream');
    assert.equal(history[2]?.content, 'Turn 2 User');
    assert.equal(history[3]?.content, 'Spy response stream');

    // On Turn 2, spy received: system memory (1) + Turn 1 user (2) + Turn 1 asst (3) + Turn 2 user (4) = 4 messages
    assert.equal(spyProvider.lastReceivedMessages.length, 4);
    assert.equal(spyProvider.lastReceivedMessages[0]?.role, 'system');
    assert.equal(spyProvider.lastReceivedMessages[1]?.content, 'Turn 1 User');
    assert.equal(spyProvider.lastReceivedMessages[2]?.content, 'Spy response stream');
    assert.equal(spyProvider.lastReceivedMessages[3]?.content, 'Turn 2 User');

    closeDatabase(db);
  });

  it('9. Memory retrieval failures safely roll back user turn and do not corrupt conversation history', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const memoryRepo = new MemoryRepository(db);
    const messageRepo = new MessageRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const spyProvider = new SpyAIProvider();

    // Create a MemoryService that throws an error when building context
    const faultyMemoryService = new MemoryService({ repository: memoryRepo });
    faultyMemoryService.buildMemoryPromptContext = () => {
      throw new Error('Simulated memory database failure');
    };

    const engine = new ConversationEngine({
      defaultProvider: spyProvider,
      historyManager,
      memoryService: faultyMemoryService,
    });

    let reportedError: Error | null = null;
    await engine.processUserMessage('session-faulty-mem', 'Faulty memory test', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => {
        reportedError = err;
      },
    });

    assert.ok(reportedError);
    assert.equal((reportedError as Error).message, 'Simulated memory database failure');

    // The user turn must be cleanly rolled back from SQLite
    assert.equal(historyManager.getHistory('session-faulty-mem').length, 0);

    // Active controller must be cleaned up
    assert.equal(engine.hasActiveGeneration('session-faulty-mem'), false);

    // Provider was never invoked
    assert.equal(spyProvider.lastReceivedMessages.length, 0);

    closeDatabase(db);
  });
});

