import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, ATLAS_SYSTEM_INSTRUCTION, type GeminiClientLike } from '../src/services/ai/geminiProvider.js';
import { AIProviderError } from '../src/services/ai/types.js';
import { ConversationEngine } from '../src/services/ai/conversationEngine.js';
import { ConversationHistoryManager } from '../src/services/ai/conversationHistory.js';
import { parseAIProvider, parseGeminiApiKey } from '../src/config/index.js';
import { createAIProvider } from '../src/services/ai/providerFactory.js';
import { MockAIProvider } from '../src/services/ai/mockProvider.js';

interface MockClientOptions {
  generateResponseText?: string;
  generateUsage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  streamChunks?: string[];
  streamChunkDelayMs?: number;
  throwOnGenerate?: Error;
  throwOnStream?: Error;
}

function createMockGeminiClient(options: MockClientOptions = {}, captured: { lastParams?: unknown } = {}): GeminiClientLike {
  return {
    models: {
      async generateContent(params) {
        captured.lastParams = params;
        if (params.config?.abortSignal?.aborted) {
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        }
        if (options.throwOnGenerate) {
          throw options.throwOnGenerate;
        }
        return {
          text: options.generateResponseText ?? 'Mock response from Gemini',
          usageMetadata: options.generateUsage ?? {
            promptTokenCount: 15,
            candidatesTokenCount: 30,
            totalTokenCount: 45,
          },
        };
      },

      async generateContentStream(params) {
        captured.lastParams = params;
        if (params.config?.abortSignal?.aborted) {
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        }
        if (options.throwOnStream) {
          throw options.throwOnStream;
        }

        const chunks = options.streamChunks ?? ['Hello ', 'from ', 'Gemini ', 'model!'];
        const delay = options.streamChunkDelayMs ?? 5;

        return (async function* () {
          for (const text of chunks) {
            if (params.config?.abortSignal?.aborted) {
              const err = new Error('The user aborted a request.');
              err.name = 'AbortError';
              throw err;
            }
            if (delay > 0) {
              await new Promise((r) => setTimeout(r, delay));
            }
            yield { text };
          }
        })();
      },
    },
  };
}

describe('Gemini AI Provider Unit Tests', () => {
  it('Initializes properly with valid API key and mock client', () => {
    const client = createMockGeminiClient();
    const provider = new GeminiProvider({
      apiKey: 'test-api-key',
      client,
    });

    assert.equal(provider.name, 'gemini-provider');
    assert.equal(provider.version, '1.0.0');
  });

  it('Configures apiVersion as v1beta by default for developer/system instruction compatibility', () => {
    const provider = new GeminiProvider({ apiKey: 'test-api-key' });
    const client = (provider as unknown as { client: { apiVersion?: string } }).client;
    assert.equal(client.apiVersion, 'v1beta');

    const providerCustom = new GeminiProvider({ apiKey: 'test-api-key', apiVersion: 'v1alpha' });
    const clientCustom = (providerCustom as unknown as { client: { apiVersion?: string } }).client;
    assert.equal(clientCustom.apiVersion, 'v1alpha');
  });

  it('Throws a clear configuration error when API key is missing and no client is provided', () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      assert.throws(
        () => new GeminiProvider({ apiKey: '' }),
        (err: Error) =>
          err.message.includes('Missing GEMINI_API_KEY') &&
          err.message.includes('https://aistudio.google.com/apikey')
      );
    } finally {
      if (origKey !== undefined) {
        process.env.GEMINI_API_KEY = origKey;
      }
    }
  });

  it('Uses gemini-2.5-flash as default model and accepts custom model overrides', async () => {
    const captured: { lastParams?: any } = {};
    const client = createMockGeminiClient({}, captured);

    // 1. Default model
    const providerDefault = new GeminiProvider({
      apiKey: 'test-key',
      client,
    });
    await providerDefault.generateResponse({
      messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: new Date().toISOString() }],
    });
    assert.equal(captured.lastParams?.model, 'gemini-2.5-flash');

    // 2. Custom model
    const providerCustom = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      client,
    });
    await providerCustom.generateResponse({
      messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: new Date().toISOString() }],
    });
    assert.equal(captured.lastParams?.model, 'gemini-2.0-flash');
  });

  it('Formats conversation history and system instructions according to Gemini spec', async () => {
    const captured: { lastParams?: any } = {};
    const client = createMockGeminiClient({}, captured);

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      client,
    });

    await provider.generateResponse({
      messages: [
        { id: '1', role: 'system', content: 'You speak like a thinking partner.', timestamp: 't1' },
        { id: '2', role: 'user', content: 'Who are you?', timestamp: 't2' },
        { id: '3', role: 'assistant', content: 'I am ATLAS.', timestamp: 't3' },
        { id: '4', role: 'user', content: 'What can you do?', timestamp: 't4' },
      ],
    });

    const params = captured.lastParams;
    assert.ok(params);

    // System instruction check
    assert.ok(params.config.systemInstruction.includes('You speak like a thinking partner.'));
    assert.ok(params.config.systemInstruction.includes('ATLAS'));
    assert.ok(params.config.systemInstruction.includes('personal AI thinking partner and mentor'));
    assert.ok(params.config.systemInstruction.includes('Conciseness'));
    assert.ok(params.config.systemInstruction.includes('Language Adaptation'));

    // Dialogue turns mapping: user -> user, assistant -> model
    assert.equal(params.contents.length, 3);
    assert.equal(params.contents[0].role, 'user');
    assert.equal(params.contents[0].parts[0].text, 'Who are you?');
    assert.equal(params.contents[1].role, 'model');
    assert.equal(params.contents[1].parts[0].text, 'I am ATLAS.');
    assert.equal(params.contents[2].role, 'user');
    assert.equal(params.contents[2].parts[0].text, 'What can you do?');
  });

  it('Injects default ATLAS persona and response rules into systemInstruction when no custom system prompt is provided', async () => {
    const captured: { lastParams?: any } = {};
    const client = createMockGeminiClient({}, captured);

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      client,
    });

    await provider.generateResponse({
      messages: [
        { id: '1', role: 'user', content: 'Hello ATLAS', timestamp: 't1' },
      ],
    });

    const params = captured.lastParams;
    assert.ok(params);
    assert.equal(params.config.systemInstruction, ATLAS_SYSTEM_INSTRUCTION);
    assert.ok(params.config.systemInstruction.includes('personal AI thinking partner and mentor'));
    assert.ok(params.config.systemInstruction.includes('Conciseness'));
    assert.ok(params.config.systemInstruction.includes('No Filler'));
    assert.ok(params.config.systemInstruction.includes('Language Adaptation'));
  });

  it('Generates a complete single-turn response with token usage metadata', async () => {
    const client = createMockGeminiClient({
      generateResponseText: 'ATLAS is ready.',
      generateUsage: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    });

    const provider = new GeminiProvider({ apiKey: 'test-key', client });
    const result = await provider.generateResponse({
      messages: [{ id: '1', role: 'user', content: 'Status check', timestamp: new Date().toISOString() }],
    });

    assert.equal(result.text, 'ATLAS is ready.');
    assert.equal(result.usage?.promptTokens, 10);
    assert.equal(result.usage?.completionTokens, 20);
    assert.equal(result.usage?.totalTokens, 30);
  });

  it('Streams response chunks sequentially with accurate indices', async () => {
    const client = createMockGeminiClient({
      streamChunks: ['Voice ', 'first ', 'architecture'],
      streamChunkDelayMs: 2,
    });

    const provider = new GeminiProvider({ apiKey: 'test-key', client });
    const chunks: Array<{ text: string; index: number }> = [];

    for await (const chunk of provider.streamResponse({
      messages: [{ id: '1', role: 'user', content: 'Tell me', timestamp: new Date().toISOString() }],
    })) {
      chunks.push({ text: chunk.text, index: chunk.index });
    }

    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks, [
      { text: 'Voice ', index: 0 },
      { text: 'first ', index: 1 },
      { text: 'architecture', index: 2 },
    ]);
  });

  it('Maps HTTP 429 / RESOURCE_EXHAUSTED errors to GEMINI_QUOTA_EXCEEDED (retryable)', async () => {
    const error429 = Object.assign(new Error('Resource has been exhausted (e.g. check quota).'), {
      status: 429,
    });
    const client = createMockGeminiClient({ throwOnGenerate: error429 });
    const provider = new GeminiProvider({ apiKey: 'test-key', client });

    await assert.rejects(
      async () => {
        await provider.generateResponse({
          messages: [{ id: '1', role: 'user', content: 'Heavy query', timestamp: new Date().toISOString() }],
        });
      },
      (err: Error) => {
        assert.ok(err instanceof AIProviderError);
        assert.equal((err as AIProviderError).code, 'GEMINI_QUOTA_EXCEEDED');
        assert.equal((err as AIProviderError).isRetryable, true);
        return true;
      }
    );
  });

  it('Maps HTTP 401/403 authentication errors to GEMINI_AUTH_FAILED (non-retryable)', async () => {
    const error403 = Object.assign(new Error('API key not valid. Please pass a valid API key.'), {
      status: 403,
    });
    const client = createMockGeminiClient({ throwOnGenerate: error403 });
    const provider = new GeminiProvider({ apiKey: 'test-key', client });

    await assert.rejects(
      async () => {
        await provider.generateResponse({
          messages: [{ id: '1', role: 'user', content: 'Unauthorized', timestamp: new Date().toISOString() }],
        });
      },
      (err: Error) => {
        assert.ok(err instanceof AIProviderError);
        assert.equal((err as AIProviderError).code, 'GEMINI_AUTH_FAILED');
        assert.equal((err as AIProviderError).isRetryable, false);
        return true;
      }
    );
  });

  it('Maps HTTP 500/503 server errors to GEMINI_SERVICE_ERROR (retryable)', async () => {
    const error503 = Object.assign(new Error('The service is temporarily overloaded.'), {
      status: 503,
    });
    const client = createMockGeminiClient({ throwOnGenerate: error503 });
    const provider = new GeminiProvider({ apiKey: 'test-key', client });

    await assert.rejects(
      async () => {
        await provider.generateResponse({
          messages: [{ id: '1', role: 'user', content: 'Service down', timestamp: new Date().toISOString() }],
        });
      },
      (err: Error) => {
        assert.ok(err instanceof AIProviderError);
        assert.equal((err as AIProviderError).code, 'GEMINI_SERVICE_ERROR');
        assert.equal((err as AIProviderError).isRetryable, true);
        return true;
      }
    );
  });

  it('Sanitizes error messages to prevent leaking API keys', async () => {
    const rawKey = 'AIzaSySecretApiKey1234567890abcdef';
    const leakingError = Object.assign(
      new Error(`Failed to call endpoint https://generativelanguage.googleapis.com?key=${rawKey}`),
      { status: 400 }
    );

    const client = createMockGeminiClient({ throwOnGenerate: leakingError });
    const provider = new GeminiProvider({ apiKey: rawKey, client });

    await assert.rejects(
      async () => {
        await provider.generateResponse({
          messages: [{ id: '1', role: 'user', content: 'Check leak', timestamp: new Date().toISOString() }],
        });
      },
      (err: Error) => {
        assert.ok(!err.message.includes(rawKey), 'Must not contain raw API key');
        assert.ok(err.message.includes('[REDACTED]'), 'Must replace API key with [REDACTED]');
        return true;
      }
    );
  });

  it('Respects AbortSignal before and during streaming', async () => {
    const client = createMockGeminiClient({
      streamChunks: ['Chunk 1', 'Chunk 2', 'Chunk 3'],
      streamChunkDelayMs: 25,
    });
    const provider = new GeminiProvider({ apiKey: 'test-key', client });

    // 1. Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();

    await assert.rejects(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of provider.streamResponse({
          messages: [{ id: '1', role: 'user', content: 'test', timestamp: new Date().toISOString() }],
          signal: preAborted.signal,
        })) {
          // Should not reach
        }
      },
      (err: Error) => err.name === 'AbortError'
    );

    // 2. Mid-stream abort
    const midController = new AbortController();
    let receivedCount = 0;

    await assert.rejects(
      async () => {
        for await (const chunk of provider.streamResponse({
          messages: [{ id: '1', role: 'user', content: 'test', timestamp: new Date().toISOString() }],
          signal: midController.signal,
        })) {
          receivedCount++;
          if (chunk.index === 0) {
            midController.abort();
          }
        }
      },
      (err: Error) => err.name === 'AbortError'
    );

    assert.equal(receivedCount, 1, 'Stream consumption must halt promptly upon AbortSignal');
  });

  it('Seamlessly integrates with ConversationEngine (multi-turn + rollback on abort)', async () => {
    const client = createMockGeminiClient({
      streamChunks: ['Gemini ', 'turn ', 'response.'],
      streamChunkDelayMs: 5,
    });
    const provider = new GeminiProvider({ apiKey: 'test-key', client });
    const historyManager = new ConversationHistoryManager();
    const engine = new ConversationEngine({
      defaultProvider: provider,
      historyManager,
    });

    // Turn 1
    let turn1Text = '';
    await engine.processUserMessage('session-gemini', 'First turn', {
      onStart: () => {},
      onDelta: () => {},
      onComplete: (full) => {
        turn1Text = full;
      },
      onCancelled: () => assert.fail('Should not cancel'),
      onError: (err) => assert.fail(err.message),
    });

    assert.equal(turn1Text, 'Gemini turn response.');
    assert.equal(historyManager.getHistory('session-gemini').length, 2);

    // Cancellation test: simulate abort during turn 2
    const slowClient = createMockGeminiClient({
      streamChunks: ['Slow 1', 'Slow 2', 'Slow 3'],
      streamChunkDelayMs: 30,
    });
    const slowProvider = new GeminiProvider({ apiKey: 'test-key', client: slowClient });
    engine.setProvider(slowProvider);

    let wasCancelled = false;
    const cancelPromise = engine.processUserMessage('session-gemini', 'Second turn to cancel', {
      onStart: () => {},
      onDelta: (chunk) => {
        if (chunk.includes('Slow 1')) {
          engine.cancelGeneration('session-gemini');
        }
      },
      onComplete: () => assert.fail('Should not complete cancelled turn'),
      onCancelled: () => {
        wasCancelled = true;
      },
      onError: (err) => assert.fail(err.message),
    });

    await cancelPromise;
    assert.ok(wasCancelled);

    // History must rollback turn 2's user message cleanly, preserving turn 1
    const history = historyManager.getHistory('session-gemini');
    assert.equal(history.length, 2, 'Incomplete user turn must be rolled back');
    assert.equal(history[0]?.content, 'First turn');
    assert.equal(history[1]?.content, 'Gemini turn response.');
  });

  it('Automatically retries on HTTP 503 / overloaded error and succeeds on subsequent retry', async () => {
    let callCount = 0;
    const client: GeminiClientLike = {
      models: {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            const err503 = Object.assign(new Error('The model is overloaded. Please try again later.'), { status: 503 });
            throw err503;
          }
          return { text: 'Recovered after 503 retry' };
        },
        async generateContentStream() {
          throw new Error('Not implemented in this test');
        },
      },
    };

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      client,
      retryDelaysMs: [5, 10],
    });

    const result = await provider.generateResponse({
      messages: [{ id: '1', role: 'user', content: 'Hello', timestamp: 't1' }],
    });

    assert.equal(callCount, 2);
    assert.equal(result.text, 'Recovered after 503 retry');
  });

  it('Falls back to secondary model when primary model stays overloaded with 503 errors', async () => {
    const modelsCalled: string[] = [];
    const client: GeminiClientLike = {
      models: {
        async generateContent(params) {
          modelsCalled.push(params.model);
          if (params.model === 'gemini-2.5-flash') {
            const err503 = Object.assign(new Error('The model is overloaded.'), { status: 503 });
            throw err503;
          }
          return { text: 'Response from fallback model' };
        },
        async generateContentStream() {
          throw new Error('Not implemented in this test');
        },
      },
    };

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.5-flash',
      fallbackModel: 'gemini-2.0-flash',
      client,
      retryDelaysMs: [5, 5],
    });

    const result = await provider.generateResponse({
      messages: [{ id: '1', role: 'user', content: 'Hello', timestamp: 't1' }],
    });

    assert.ok(modelsCalled.includes('gemini-2.5-flash'));
    assert.equal(modelsCalled[modelsCalled.length - 1], 'gemini-2.0-flash');
    assert.equal(result.text, 'Response from fallback model');
  });
});

describe('AI Provider Configuration & Selection Tests', () => {
  it('parseAIProvider defaults to mock and accepts gemini', () => {
    assert.equal(parseAIProvider(undefined), 'mock');
    assert.equal(parseAIProvider(''), 'mock');
    assert.equal(parseAIProvider('mock'), 'mock');
    assert.equal(parseAIProvider('MOCK'), 'mock');
    assert.equal(parseAIProvider('gemini'), 'gemini');
    assert.equal(parseAIProvider('GEMINI'), 'gemini');

    assert.throws(
      () => parseAIProvider('openai'),
      (err: Error) => err.message.includes('Invalid AI_PROVIDER "openai"')
    );
  });

  it('parseGeminiApiKey requires key only when provider is gemini', () => {
    // When provider is mock, missing key is allowed
    assert.equal(parseGeminiApiKey(undefined, 'mock'), undefined);
    assert.equal(parseGeminiApiKey('', 'mock'), undefined);

    // When provider is gemini, missing key throws
    assert.throws(
      () => parseGeminiApiKey(undefined, 'gemini'),
      (err: Error) => err.message.includes('Missing GEMINI_API_KEY')
    );
    assert.throws(
      () => parseGeminiApiKey('   ', 'gemini'),
      (err: Error) => err.message.includes('Missing GEMINI_API_KEY')
    );

    // Valid key returns trimmed string
    assert.equal(parseGeminiApiKey('  valid-key  ', 'gemini'), 'valid-key');
  });

  it('createAIProvider returns MockAIProvider by default without credentials', () => {
    const provider = createAIProvider();
    assert.ok(provider instanceof MockAIProvider);
    assert.equal(provider.name, 'mock-provider');
  });
});

