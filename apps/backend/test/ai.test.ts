import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAIProvider } from '../src/services/ai/mockProvider.js';
import { ConversationHistoryManager } from '../src/services/ai/conversationHistory.js';
import { ConversationEngine } from '../src/services/ai/conversationEngine.js';
import { AIProviderError } from '../src/services/ai/types.js';

describe('AI Provider & Conversation Engine Unit Tests', () => {
  let mockProvider: MockAIProvider;
  let historyManager: ConversationHistoryManager;
  let engine: ConversationEngine;

  beforeEach(() => {
    mockProvider = new MockAIProvider({ chunkDelayMs: 5 });
    historyManager = new ConversationHistoryManager();
    engine = new ConversationEngine({
      defaultProvider: mockProvider,
      historyManager,
    });
  });

  it('Mock provider generates predictable deterministic response', async () => {
    const result = await mockProvider.generateResponse({
      messages: [
        { id: '1', role: 'user', content: 'What is ATLAS?', timestamp: new Date().toISOString() },
      ],
    });

    assert.ok(result.text.includes('What is ATLAS?'));
    assert.ok(result.text.includes('[Mock AI Response: Turn 1]'));
    assert.ok(result.usage && result.usage.totalTokens! > 0);
  });

  it('Mock provider streams in multiple sequential chunks', async () => {
    const chunks: string[] = [];
    for await (const chunk of mockProvider.streamResponse({
      messages: [
        { id: '1', role: 'user', content: 'Stream test', timestamp: new Date().toISOString() },
      ],
    })) {
      chunks.push(chunk.text);
    }

    assert.ok(chunks.length >= 3, 'Must stream multiple chunks');
    assert.ok(chunks.join('').includes('Stream test'));
  });

  it('Mock provider respects AbortSignal promptly', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of mockProvider.streamResponse({
          messages: [{ id: '1', role: 'user', content: 'Abort test', timestamp: new Date().toISOString() }],
          signal: controller.signal,
        })) {
          // should not yield
        }
      },
      (err: Error) => err.name === 'AbortError'
    );
  });

  it('Maintains separate conversation history across multiple sessions', () => {
    historyManager.addMessage('session-1', {
      id: 'm1',
      role: 'user',
      content: 'Message for session 1',
      timestamp: new Date().toISOString(),
    });

    historyManager.addMessage('session-2', {
      id: 'm2',
      role: 'user',
      content: 'Message for session 2',
      timestamp: new Date().toISOString(),
    });

    const hist1 = historyManager.getHistory('session-1');
    const hist2 = historyManager.getHistory('session-2');

    assert.equal(hist1.length, 1);
    assert.equal(hist2.length, 1);
    assert.equal(hist1[0]?.content, 'Message for session 1');
    assert.equal(hist2[0]?.content, 'Message for session 2');
  });

  it('Conversation engine manages conversation turns and accumulates context', async () => {
    const deltas: string[] = [];
    let completedText = '';

    // Turn 1
    await engine.processUserMessage('session-turn', 'Hello Atlas', {
      onStart: () => {},
      onDelta: (chunk) => deltas.push(chunk),
      onComplete: (full) => {
        completedText = full;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(completedText.includes('Hello Atlas'));
    assert.ok(completedText.includes('Turn 1'));

    // Turn 2
    let turn2Completed = '';
    await engine.processUserMessage('session-turn', 'Tell me more', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (full) => {
        turn2Completed = full;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(turn2Completed.includes('Turn 3'));
    const finalHistory = historyManager.getHistory('session-turn');
    assert.equal(finalHistory.length, 4);
    assert.equal(finalHistory[0]?.role, 'user');
    assert.equal(finalHistory[1]?.role, 'assistant');
    assert.equal(finalHistory[2]?.role, 'user');
    assert.equal(finalHistory[3]?.role, 'assistant');
  });

  it('Rejects concurrent requests in the same session', async () => {
    const slowProvider = new MockAIProvider({ chunkDelayMs: 40 });
    const slowEngine = new ConversationEngine({
      defaultProvider: slowProvider,
      historyManager,
    });

    const p1 = slowEngine.processUserMessage('session-concurrent', 'First slow request', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onError: () => {},
    });

    // Attempt second request while first is running
    await assert.rejects(
      async () => {
        await slowEngine.processUserMessage('session-concurrent', 'Second rapid request', {
          onStart: () => {},
          onDelta: () => {},
          onComplete: () => {},
          onCancelled: () => {},
          onError: () => {},
        });
      },
      (err: Error) => err.message.includes('CONCURRENT_REQUEST_NOT_ALLOWED')
    );

    // Let first request complete cleanly
    await p1;
  });

  it('Cancels active generation cleanly and rolls back incomplete user turn', async () => {
    const slowProvider = new MockAIProvider({ chunkDelayMs: 40 });
    const slowEngine = new ConversationEngine({
      defaultProvider: slowProvider,
      historyManager,
    });

    let wasCancelled = false;
    let receivedAnyDelta = false;

    const promise = slowEngine.processUserMessage(
      'session-cancel',
      'Will be cancelled halfway',
      {
        onStart: () => {},
        onDelta: () => {
          receivedAnyDelta = true;
          slowEngine.cancelGeneration('session-cancel');
        },
        onComplete: () => assert.fail('Should not complete'),
        onCancelled: () => {
          wasCancelled = true;
        },
        onError: (err) => assert.fail(err.message),
      },
      { requestId: 'req-cancel-target' }
    );

    await promise;
    assert.ok(receivedAnyDelta);
    assert.ok(wasCancelled);
    assert.equal(slowEngine.hasActiveGeneration('session-cancel'), false);

    // History must NOT contain the incomplete user message or assistant message
    const historyAfterCancel = historyManager.getHistory('session-cancel');
    assert.equal(historyAfterCancel.length, 0, 'Cancelled turn must be rolled back');

    // Subsequent turn should execute as Turn 1
    let nextTurnText = '';
    await slowEngine.processUserMessage('session-cancel', 'New question after cancel', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (text) => {
        nextTurnText = text;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(nextTurnText.includes('Turn 1'), 'Subsequent turn must start cleanly without orphaned context');
    assert.equal(historyManager.getHistory('session-cancel').length, 2);
  });

  it('Targeted cancellation respects matching and non-matching requestIds', async () => {
    const slowProvider = new MockAIProvider({ chunkDelayMs: 40 });
    const slowEngine = new ConversationEngine({
      defaultProvider: slowProvider,
      historyManager,
    });

    const p = slowEngine.processUserMessage(
      'session-target',
      'Long generation',
      {
        onStart: () => {},
        onDelta: () => {},
        onComplete: () => {},
        onCancelled: () => {},
        onError: () => {},
      },
      { requestId: 'req-correct-123' }
    );

    // Attempt cancel with mismatched requestId
    const cancelledWrong = slowEngine.cancelGeneration('session-target', 'req-wrong-999');
    assert.equal(cancelledWrong, false, 'Must not cancel mismatched requestId');
    assert.equal(slowEngine.hasActiveGeneration('session-target'), true);

    // Cancel with matching requestId
    const cancelledRight = slowEngine.cancelGeneration('session-target', 'req-correct-123');
    assert.equal(cancelledRight, true, 'Must cancel matching requestId');
    assert.equal(slowEngine.hasActiveGeneration('session-target'), false);

    await p;
  });

  it('Handles provider errors gracefully', async () => {
    let capturedError: Error | null = null;

    await engine.processUserMessage('session-err', 'Trigger: [simulate_error]', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: () => assert.fail('Should not complete on simulated error'),
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => {
        capturedError = err;
      },
    });

    assert.ok(capturedError !== null);
    const err = capturedError as unknown;
    assert.ok(err instanceof AIProviderError);
    assert.equal((err as AIProviderError).code, 'MOCK_SIMULATED_ERROR');
  });
});
