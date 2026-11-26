import {
  type AIProvider,
  AIProviderError,
  type GenerateOptions,
  type GenerateResult,
  type StreamChunk,
  type StreamOptions,
} from './types.js';

export interface MockProviderOptions {
  /** Delay between chunks in milliseconds (default: 15ms) */
  chunkDelayMs?: number;
  /** Whether to simulate an error on specific trigger inputs */
  errorTrigger?: string;
}

/**
 * Deterministic Mock AI Provider for testing and local development.
 * Explicitly identifies itself as a test mock and does not pretend to be a real AI model.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock-provider';
  readonly version = '1.0.0';

  private readonly chunkDelayMs: number;
  private readonly errorTrigger: string;

  constructor(options: MockProviderOptions = {}) {
    this.chunkDelayMs = options.chunkDelayMs ?? 15;
    this.errorTrigger = options.errorTrigger ?? '[simulate_error]';
  }

  private checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new Error('AI generation cancelled');
      err.name = 'AbortError';
      throw err;
    }
  }

  private async sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    this.checkAborted(signal);
    if (ms <= 0) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const err = new Error('AI generation cancelled');
        err.name = 'AbortError';
        reject(err);
      };

      signal?.addEventListener('abort', onAbort);
    });
  }

  private buildMockResponse(lastUserContent: string, historyCount: number): string[] {
    if (lastUserContent.includes(this.errorTrigger)) {
      throw new AIProviderError(
        'Simulated AI provider failure for testing.',
        'MOCK_SIMULATED_ERROR',
        false
      );
    }

    // Predictable chunks that reflect the input and context turn count
    return [
      `[Mock AI Response: `,
      `Turn ${historyCount}] `,
      `Received: "${lastUserContent}". `,
      `Processing complete.`,
    ];
  }

  async generateResponse(options: GenerateOptions): Promise<GenerateResult> {
    this.checkAborted(options.signal);

    const userMessages = options.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    const lastContent = lastUser?.content ?? '';

    await this.sleepWithAbort(this.chunkDelayMs, options.signal);

    const chunks = this.buildMockResponse(lastContent, options.messages.length);
    const fullText = chunks.join('');

    return {
      text: fullText,
      usage: {
        promptTokens: lastContent.length,
        completionTokens: fullText.length,
        totalTokens: lastContent.length + fullText.length,
      },
    };
  }

  async *streamResponse(options: StreamOptions): AsyncIterable<StreamChunk> {
    this.checkAborted(options.signal);

    const userMessages = options.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    const lastContent = lastUser?.content ?? '';

    const chunks = this.buildMockResponse(lastContent, options.messages.length);

    for (let i = 0; i < chunks.length; i++) {
      await this.sleepWithAbort(this.chunkDelayMs, options.signal);
      this.checkAborted(options.signal);

      yield {
        text: chunks[i]!,
        index: i,
        isFinal: i === chunks.length - 1,
      };
    }
  }
}

export const mockAIProvider = new MockAIProvider();

