import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  initDatabase,
  closeDatabase,
  SessionRepository,
  MessageRepository,
} from '../src/db/index.js';
import { ConversationHistoryManager } from '../src/services/ai/conversationHistory.js';
import { ConversationEngine } from '../src/services/ai/conversationEngine.js';
import { MockAIProvider } from '../src/services/ai/mockProvider.js';
import type {
  AIProvider,
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  StreamChunk,
  StreamOptions,
} from '../src/services/ai/types.js';

/**
 * Recording AI provider that captures the exact message arrays received on every turn
 */
class RecordingAIProvider implements AIProvider {
  readonly name = 'recording-provider';
  readonly version = '1.0.0';
  readonly calls: Array<readonly ChatMessage[]> = [];

  async generateResponse(options: GenerateOptions): Promise<GenerateResult> {
    this.calls.push([...options.messages]);
    const lastUser = options.messages.filter((m) => m.role === 'user').pop();
    const text = `Response to: ${lastUser?.content ?? ''}`;
    return { text };
  }

  async *streamResponse(options: StreamOptions): AsyncIterable<StreamChunk> {
    this.calls.push([...options.messages]);
    const lastUser = options.messages.filter((m) => m.role === 'user').pop();
    const text = `Response to: ${lastUser?.content ?? ''}`;
    yield { text, index: 0, isFinal: true };
  }
}

describe('Real-Time Topic Switching & Multi-Turn Conversation Continuity', () => {
  it('1. Seamlessly pivots between technical, personal, and general topics within a single session', async () => {
    const provider = new RecordingAIProvider();
    const historyManager = new ConversationHistoryManager();
    const engine = new ConversationEngine({
      defaultProvider: provider,
      historyManager,
      memoryService: undefined,
      recallService: undefined,
    });

    const sessionId = 'session-topic-pivot-1';

    // Topic 1: Technical (C++ DSA Pointers)
    const topic1Msg = 'Can you explain how pointers and dynamic memory work in C++ DSA?';
    let response1 = '';
    await engine.processUserMessage(sessionId, topic1Msg, {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        response1 = text;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });
    assert.ok(response1.includes(topic1Msg));
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.length, 1);
    assert.equal(provider.calls[0]![0]!.content, topic1Msg);

    // Topic 1 Follow-up
    const topic1FollowUp = 'How does pointer arithmetic behave when traversing an array?';
    let response2 = '';
    await engine.processUserMessage(sessionId, topic1FollowUp, {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        response2 = text;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });
    assert.ok(response2.includes(topic1FollowUp));
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[1]?.length, 3);
    assert.equal(provider.calls[1]![0]!.content, topic1Msg);
    assert.equal(provider.calls[1]![1]!.role, 'assistant');
    assert.equal(provider.calls[1]![2]!.content, topic1FollowUp);

    // Topic 2: Abrupt Pivot to Sports (Cricket)
    const topic2Msg = 'Switching topics: who holds the record for the highest individual score in Test cricket?';
    let response3 = '';
    await engine.processUserMessage(sessionId, topic2Msg, {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        response3 = text;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });
    assert.ok(response3.includes(topic2Msg));
    assert.equal(provider.calls.length, 3);
    assert.equal(provider.calls[2]?.length, 5);
    // History contains both prior C++ turns and the new cricket query in distinct sequential order
    assert.equal(provider.calls[2]![4]!.content, topic2Msg);
    assert.equal(provider.calls[2]![4]!.role, 'user');

    // Topic 3: Pivot to Entertainment (Cinema)
    const topic3Msg = 'What are some critically acclaimed sci-fi films similar to Interstellar?';
    let response4 = '';
    await engine.processUserMessage(sessionId, topic3Msg, {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        response4 = text;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });
    assert.ok(response4.includes(topic3Msg));
    assert.equal(provider.calls.length, 4);
    assert.equal(provider.calls[3]?.length, 7);
    assert.equal(provider.calls[3]![6]!.content, topic3Msg);

    // Topic 4: Return to Technical Topic (C++ DSA Graph Algorithms)
    const topic4Msg = 'Back to DSA: how do you detect cycles in a directed graph using Kahn algorithm?';
    let response5 = '';
    await engine.processUserMessage(sessionId, topic4Msg, {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        response5 = text;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });
    assert.ok(response5.includes(topic4Msg));
    assert.equal(provider.calls.length, 5);
    assert.equal(provider.calls[4]?.length, 9);
    assert.equal(provider.calls[4]![8]!.content, topic4Msg);

    // Verify overall history state
    const history = historyManager.getHistory(sessionId);
    assert.equal(history.length, 10);
    // Verify strict alternating roles: user -> assistant -> user -> assistant ...
    for (let i = 0; i < history.length; i++) {
      const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
      assert.equal(history[i]?.role, expectedRole, `Message at index ${i} must have role ${expectedRole}`);
    }

    // Verify timestamps are non-decreasing
    for (let i = 1; i < history.length; i++) {
      const prev = new Date(history[i - 1]!.timestamp).getTime();
      const curr = new Date(history[i]!.timestamp).getTime();
      assert.ok(curr >= prev, 'Timestamps must be monotonically non-decreasing');
    }
  });

  it('2. Session isolation guarantees zero context contamination during rapid interleaved turns', async () => {
    const provider = new RecordingAIProvider();
    const historyManager = new ConversationHistoryManager();
    const engine = new ConversationEngine({
      defaultProvider: provider,
      historyManager,
      memoryService: undefined,
      recallService: undefined,
    });

    const sessionA = 'session-track-technical-cricket';
    const sessionB = 'session-track-cooking-cinema';

    // Interleaved Turn 1
    await engine.processUserMessage(sessionA, 'Session A: Explain C++ std::unique_ptr.', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    await engine.processUserMessage(sessionB, 'Session B: What spices go into authentic garam masala?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    // Interleaved Turn 2
    await engine.processUserMessage(sessionA, 'Session A: Who won the 2011 Cricket World Cup?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    await engine.processUserMessage(sessionB, 'Session B: Name three masterpieces directed by Akira Kurosawa.', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    // Interleaved Turn 3
    await engine.processUserMessage(sessionA, 'Session A: What is the time complexity of QuickSelect?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    await engine.processUserMessage(sessionB, 'Session B: How do you achieve a flaky crust on sourdough bread?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    assert.equal(provider.calls.length, 6);

    // Call 0: Session A Turn 1 (1 message)
    assert.equal(provider.calls[0]?.length, 1);
    assert.ok(provider.calls[0]![0]!.content.includes('Session A: Explain C++'));

    // Call 1: Session B Turn 1 (1 message) - Must contain ZERO C++ content
    assert.equal(provider.calls[1]?.length, 1);
    assert.ok(provider.calls[1]![0]!.content.includes('Session B: What spices'));
    assert.ok(!provider.calls[1]![0]!.content.includes('Session A'));
    assert.ok(!provider.calls[1]![0]!.content.includes('C++'));

    // Call 2: Session A Turn 2 (3 messages) - Must contain ONLY Session A messages
    assert.equal(provider.calls[2]?.length, 3);
    for (const msg of provider.calls[2]!) {
      assert.ok(!msg.content.includes('garam masala'));
      assert.ok(!msg.content.includes('Session B'));
    }

    // Call 3: Session B Turn 2 (3 messages) - Must contain ONLY Session B messages
    assert.equal(provider.calls[3]?.length, 3);
    for (const msg of provider.calls[3]!) {
      assert.ok(!msg.content.includes('Cricket'));
      assert.ok(!msg.content.includes('C++'));
      assert.ok(!msg.content.includes('Session A'));
    }

    // Call 4: Session A Turn 3 (5 messages) - Zero contamination from Kurosawa or cooking
    assert.equal(provider.calls[4]?.length, 5);
    for (const msg of provider.calls[4]!) {
      assert.ok(!msg.content.includes('Kurosawa'));
      assert.ok(!msg.content.includes('garam masala'));
    }

    // Call 5: Session B Turn 3 (5 messages) - Zero contamination from QuickSelect or Cricket
    assert.equal(provider.calls[5]?.length, 5);
    for (const msg of provider.calls[5]!) {
      assert.ok(!msg.content.includes('QuickSelect'));
      assert.ok(!msg.content.includes('Cricket'));
    }

    // Verify distinct stored histories
    const histA = historyManager.getHistory(sessionA);
    const histB = historyManager.getHistory(sessionB);

    assert.equal(histA.length, 6);
    assert.equal(histB.length, 6);

    for (const msg of histA) {
      assert.ok(!msg.content.includes('Session B'));
      assert.ok(!msg.content.includes('garam masala'));
      assert.ok(!msg.content.includes('Kurosawa'));
      assert.ok(!msg.content.includes('sourdough'));
    }

    for (const msg of histB) {
      assert.ok(!msg.content.includes('Session A'));
      assert.ok(!msg.content.includes('C++'));
      assert.ok(!msg.content.includes('Cricket'));
      assert.ok(!msg.content.includes('QuickSelect'));
    }
  });

  it('3. Topic pivot with persistent SQLite database maintains monotonic message storage', async () => {
    const { db } = initDatabase({ path: ':memory:' });
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);
    const historyManager = new ConversationHistoryManager({ messageRepository: messageRepo });
    const provider = new RecordingAIProvider();

    const engine = new ConversationEngine({
      defaultProvider: provider,
      historyManager,
      memoryService: undefined,
      recallService: undefined,
    });

    const sessionId = crypto.randomUUID();
    sessionRepo.createSession({
      sessionId,
      connectionId: 'conn-db-continuity',
      createdAt: new Date(),
      status: 'active',
      userId: 'default_user',
    });

    // 1. Technical query
    await engine.processUserMessage(sessionId, 'Explain binary search trees in C++.', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    // 2. Pivot to cricket
    await engine.processUserMessage(sessionId, 'Pivot: Who has scored the fastest century in ODI cricket?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    // 3. Pivot to cinema
    await engine.processUserMessage(sessionId, 'Pivot: What makes the cinematography of Blade Runner 2049 distinctive?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    // Verify messages stored in SQLite
    const dbMessages = messageRepo.getMessagesBySessionId(sessionId);
    assert.equal(dbMessages.length, 6);

    assert.equal(dbMessages[0]?.role, 'user');
    assert.equal(dbMessages[0]?.content, 'Explain binary search trees in C++.');

    assert.equal(dbMessages[1]?.role, 'assistant');
    assert.ok(dbMessages[1]?.content.includes('Explain binary search trees'));

    assert.equal(dbMessages[2]?.role, 'user');
    assert.equal(dbMessages[2]?.content, 'Pivot: Who has scored the fastest century in ODI cricket?');

    assert.equal(dbMessages[3]?.role, 'assistant');
    assert.ok(dbMessages[3]?.content.includes('fastest century'));

    assert.equal(dbMessages[4]?.role, 'user');
    assert.equal(dbMessages[4]?.content, 'Pivot: What makes the cinematography of Blade Runner 2049 distinctive?');

    assert.equal(dbMessages[5]?.role, 'assistant');
    assert.ok(dbMessages[5]?.content.includes('Blade Runner 2049'));

    closeDatabase(db);
  });

  it('4. Topic switch immediately following a cancelled turn starts cleanly without orphaned context', async () => {
    const slowProvider = new MockAIProvider({ chunkDelayMs: 40 });
    const historyManager = new ConversationHistoryManager();
    const engine = new ConversationEngine({
      defaultProvider: slowProvider,
      historyManager,
      memoryService: undefined,
      recallService: undefined,
    });

    const sessionId = 'session-cancel-and-pivot';

    // Start technical turn, then cancel it halfway
    let cancelledTurnExecuted = false;
    const cancelPromise = engine.processUserMessage(
      sessionId,
      'Complex C++ template metaprogramming explanation that gets cancelled',
      {
        onStart: () => {},
        onDelta: () => {
          engine.cancelGeneration(sessionId);
        },
        onComplete: () => assert.fail('Should not complete cancelled turn'),
        onCancelled: () => {
          cancelledTurnExecuted = true;
        },
        onError: (err) => assert.fail(err.message),
      }
    );

    await cancelPromise;
    assert.ok(cancelledTurnExecuted);
    assert.equal(historyManager.getHistory(sessionId).length, 0);

    // Immediately pivot to a completely new topic: cricket trivia
    let completedPivotText = '';
    await engine.processUserMessage(
      sessionId,
      'Nevermind that. Who won the 2024 ICC Men T20 World Cup?',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: (text) => {
          completedPivotText = text;
        },
        onCancelled: () => assert.fail('Should not cancel'),
        onError: (err) => assert.fail(err.message),
      }
    );

    // Must be Turn 1 because the cancelled technical turn was cleanly rolled back
    assert.ok(completedPivotText.includes('Turn 1'));
    assert.ok(completedPivotText.includes('2024 ICC Men T20 World Cup'));

    const finalHistory = historyManager.getHistory(sessionId);
    assert.equal(finalHistory.length, 2);
    assert.equal(finalHistory[0]?.content, 'Nevermind that. Who won the 2024 ICC Men T20 World Cup?');
    assert.ok(!finalHistory[0]?.content.includes('metaprogramming'));
  });

  it('5. Topic switching preserves strict context ordering when personal memory and recall are active', async () => {
    const provider = new RecordingAIProvider();
    const historyManager = new ConversationHistoryManager();

    // Stub mock memory service providing stable user context
    const mockMemoryService = {
      buildMemoryPromptContext: (_userId?: string) =>
        '[USER PERSONAL KNOWLEDGE & CONTEXT]\n- Preferred language: English and Telugu',
    } as any;

    // Stub mock recall service returning historical excerpt when query mentions C++
    const mockRecallService = {
      buildRecallPromptContext: (opts: { query: string }) => {
        if (opts.query.toLowerCase().includes('c++')) {
          return '[RELEVANT PAST CONVERSATIONS & HISTORICAL CONTEXT]\n- Historical fact: Decided on modern C++20 for performance.';
        }
        return undefined;
      },
    } as any;

    const engine = new ConversationEngine({
      defaultProvider: provider,
      historyManager,
      memoryService: mockMemoryService,
      recallService: mockRecallService,
    });

    const sessionId = 'session-topic-with-memory-and-recall';

    // Turn 1: Mentions C++ (both memory and recall injected)
    await engine.processUserMessage(sessionId, 'How do C++ smart pointers prevent memory leaks?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    assert.equal(provider.calls.length, 1);
    // Messages sent: [ephemeral-memory, ephemeral-recall, userTurn1]
    assert.equal(provider.calls[0]?.length, 3);
    assert.equal(provider.calls[0]![0]!.id, 'ephemeral-memory-context');
    assert.equal(provider.calls[0]![1]!.id, 'ephemeral-recall-context');
    assert.equal(provider.calls[0]![2]!.role, 'user');
    assert.ok(provider.calls[0]![2]!.content.includes('smart pointers'));

    // Turn 2: Topic switch to Cricket (Memory injected, recall returns undefined)
    await engine.processUserMessage(sessionId, 'Let us pivot. Who has the highest batting average in Test cricket?', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: (err) => assert.fail(err.message),
    });

    assert.equal(provider.calls.length, 2);
    // Messages sent: [ephemeral-memory, userTurn1, assistantTurn1, userTurn2]
    assert.equal(provider.calls[1]?.length, 4);
    assert.equal(provider.calls[1]![0]!.id, 'ephemeral-memory-context');
    assert.equal(provider.calls[1]![1]!.role, 'user');
    assert.ok(provider.calls[1]![1]!.content.includes('smart pointers'));
    assert.equal(provider.calls[1]![2]!.role, 'assistant');
    assert.equal(provider.calls[1]![3]!.role, 'user');
    assert.ok(provider.calls[1]![3]!.content.includes('highest batting average'));

    // Verify stored history NEVER stored ephemeral memory or recall
    const storedHistory = historyManager.getHistory(sessionId);
    assert.equal(storedHistory.length, 4);
    for (const msg of storedHistory) {
      assert.notEqual(msg.role, 'system');
      assert.ok(!msg.content.includes('USER PERSONAL KNOWLEDGE'));
      assert.ok(!msg.content.includes('RELEVANT PAST CONVERSATIONS'));
    }
  });
});
