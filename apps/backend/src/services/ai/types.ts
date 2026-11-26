/**
 * ATLAS AI Provider & Conversation Engine Types
 *
 * Provider-agnostic interfaces designed to decouple LLM provider implementations
 * (e.g. Gemini, OpenAI, Claude, Local models) from the core conversation engine.
 */

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly timestamp: string;
}

export interface AIProviderConfig {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly [key: string]: unknown;
}

export interface GenerateOptions {
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
  readonly config?: AIProviderConfig;
}

export type StreamOptions = GenerateOptions;

export interface StreamChunk {
  readonly text: string;
  readonly index: number;
  readonly isFinal?: boolean;
}

export interface GenerateResult {
  readonly text: string;
  readonly usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Standardized AI Provider Error
 */
export class AIProviderError extends Error {
  readonly code: string;
  readonly isRetryable: boolean;

  constructor(message: string, code = 'AI_PROVIDER_ERROR', isRetryable = false) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.isRetryable = isRetryable;
  }
}

/**
 * Common interface that all AI providers must implement.
 */
export interface AIProvider {
  readonly name: string;
  readonly version: string;

  /**
   * Generates a single complete response.
   */
  generateResponse(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * Streams response chunks sequentially, respecting cancellation via AbortSignal.
   */
  streamResponse(options: StreamOptions): AsyncIterable<StreamChunk>;
}

