import { GoogleGenAI } from '@google/genai';
import {
  type AIProvider,
  AIProviderError,
  type ChatMessage,
  type GenerateOptions,
  type GenerateResult,
  type StreamChunk,
  type StreamOptions,
} from './types.js';

export interface GeminiClientLike {
  models: {
    generateContent(params: {
      model: string;
      contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      config?: {
        systemInstruction?: string;
        temperature?: number;
        abortSignal?: AbortSignal;
        [key: string]: unknown;
      };
    }): Promise<{
      text?: string;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    }>;
    generateContentStream(params: {
      model: string;
      contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      config?: {
        systemInstruction?: string;
        temperature?: number;
        abortSignal?: AbortSignal;
        [key: string]: unknown;
      };
    }): Promise<AsyncIterable<{ text?: string }>>;
  };
}

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  fallbackModel?: string;
  apiVersion?: string;
  systemInstruction?: string;
  client?: GeminiClientLike;
  retryDelaysMs?: number[];
}

export const ATLAS_SYSTEM_INSTRUCTION = `
You are ATLAS, a personal AI thinking partner and mentor (inspired by JARVIS/FRIDAY), operating as a real-time voice and multimodal companion.
Core Behavioral Rules:
1. Voice-First Identity: You communicate via spoken voice and real-time audio/text. NEVER say "I am a text-based AI", "I cannot speak", or "I do not have a voice". Speak naturally, expressively, and conversationally as if talking directly to the user over audio.
2. Conciseness: Keep everyday conversational and spoken responses short, punchy, and direct (maximum 2 to 3 sentences) unless the user explicitly asks for a detailed technical explanation, story, or Telugu breakdown.
3. No Filler: Never use robotic AI filler phrases like "As an AI...", "Sure, I can help with that!", or "Certainly!". Start your responses immediately and naturally with warmth, intellect, and subtle wit.
4. Language Adaptation: Automatically match the user's language preference (English or Telugu) based on the active dialogue context.
   - When the user speaks or asks in Telugu (or asks for Telugu explanations), respond in natural, authentic, spoken Telugu (వ్యవహారిక భాష). Explain technical concepts clearly using relatable analogies, embedding familiar English technical terms naturally (e.g., "డేటాబేస్", "ఏపీఐ", "మెమరీ") without sounding bookish, rigid, or artificial.
   - When speaking in English, maintain a sharp, supportive, JARVIS-like demeanor—calm, confident, engaging, and never dry or monotonous.
5. Situation & Emotion Attunement:
   - Deep explanation & learning: Be patient, structured, intuitive, and pedagogical.
   - Quick debugging or code checks: Razor-sharp, direct, high-signal, zero fluff.
   - Casual chat & encouragement: Warm, lively, empathetic, and companionable.
`.trim();

/**
 * Google Gemini AI Provider Implementation
 *
 * Implements the provider-independent AIProvider interface using Google's official
 * @google/genai SDK. Designed specifically for the ₹0 Gemini Developer API Free Tier.
 * Features automated 503/overloaded retries with exponential backoff and model fallback.
 */
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini-provider';
  readonly version = '1.0.0';

  private readonly client: GeminiClientLike;
  private readonly defaultModel: string;
  private readonly fallbackModel?: string;
  private readonly defaultSystemInstruction?: string;
  private readonly apiKey?: string;
  private readonly retryDelaysMs: number[];

  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = options.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    this.apiKey = apiKey;
    this.defaultModel = options.model?.trim() || process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
    this.fallbackModel =
      options.fallbackModel?.trim() ||
      process.env.GEMINI_FALLBACK_MODEL?.trim() ||
      (this.defaultModel !== 'gemini-2.0-flash' ? 'gemini-2.0-flash' : 'gemini-1.5-flash');

    const apiVersion = options.apiVersion?.trim() || 'v1beta';
    this.defaultSystemInstruction =
      options.systemInstruction || ATLAS_SYSTEM_INSTRUCTION;

    const isTest = process.env.NODE_ENV === 'test';
    this.retryDelaysMs = options.retryDelaysMs ?? (isTest ? [10, 20] : [800, 1600]);

    if (options.client) {
      this.client = options.client;
    } else {
      if (!apiKey) {
        throw new Error(
          'Missing GEMINI_API_KEY. A Gemini Developer API key is required to initialize GeminiProvider. Get a free key at https://aistudio.google.com/apikey.'
        );
      }
      this.client = new GoogleGenAI({ apiKey, apiVersion });
    }
  }

  private checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new Error('AI generation cancelled');
      err.name = 'AbortError';
      throw err;
    }
  }

  private isOverloadedOr503Error(err: unknown): boolean {
    if (!err) return false;
    const errorObj = err as Record<string, unknown>;
    const status = (errorObj.status ?? errorObj.statusCode) as number | undefined;
    if (status === 503) return true;
    const msg = String(errorObj.message || (err instanceof Error ? err.message : err)).toLowerCase();
    return (
      msg.includes('503') ||
      msg.includes('unavailable') ||
      msg.includes('overloaded') ||
      msg.includes('high demand') ||
      msg.includes('resource exhausted') ||
      msg.includes('capacity')
    );
  }

  private async sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    this.checkAborted(signal);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const abortErr = new Error('AI generation cancelled');
        abortErr.name = 'AbortError';
        reject(abortErr);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private sanitizeErrorMessage(message: string): string {
    let sanitized = message;
    if (this.apiKey) {
      sanitized = sanitized.replaceAll(this.apiKey, '[REDACTED]');
    }
    sanitized = sanitized.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]');
    sanitized = sanitized.replace(/key=[A-Za-z0-9_-]+/gi, 'key=[REDACTED]');
    return sanitized;
  }

  private formatMessages(messages: readonly ChatMessage[]): {
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
    systemInstruction?: string;
  } {
    const systemParts: string[] = [];
    if (this.defaultSystemInstruction) {
      systemParts.push(this.defaultSystemInstruction);
    }

    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content.trim()) {
          systemParts.push(msg.content.trim());
        }
      } else {
        const text = msg.content.trim();
        if (text) {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text }],
          });
        }
      }
    }

    if (contents.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: 'Hello' }],
      });
    }

    const systemInstruction = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    return { contents, systemInstruction };
  }

  private handleError(err: unknown, signal?: AbortSignal): never {
    if (signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted')))) {
      const abortErr = new Error('AI generation cancelled');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    if (err instanceof AIProviderError) {
      throw err;
    }

    const errorObj = err as Record<string, unknown> | null;
    const status = (errorObj?.status ?? errorObj?.statusCode) as number | undefined;
    const rawMessage = (errorObj?.message as string) || (err instanceof Error ? err.message : String(err));
    const sanitizedMessage = this.sanitizeErrorMessage(rawMessage);

    // Rate-limit or Quota exhaustion (HTTP 429)
    if (
      status === 429 ||
      sanitizedMessage.includes('429') ||
      sanitizedMessage.includes('RESOURCE_EXHAUSTED') ||
      sanitizedMessage.toLowerCase().includes('quota') ||
      sanitizedMessage.toLowerCase().includes('rate limit')
    ) {
      throw new AIProviderError(
        `Gemini API rate limit or quota exceeded: ${sanitizedMessage}`,
        'GEMINI_QUOTA_EXCEEDED',
        true
      );
    }

    // Authentication failure (HTTP 401 / 403)
    if (
      status === 401 ||
      status === 403 ||
      sanitizedMessage.includes('API_KEY_INVALID') ||
      sanitizedMessage.toLowerCase().includes('unauthorized') ||
      sanitizedMessage.toLowerCase().includes('forbidden')
    ) {
      throw new AIProviderError(
        `Gemini API authentication failed: ${sanitizedMessage}`,
        'GEMINI_AUTH_FAILED',
        false
      );
    }

    // Server-side errors (HTTP 5xx / 503 UNAVAILABLE)
    if ((status && status >= 500 && status < 600) || this.isOverloadedOr503Error(err)) {
      throw new AIProviderError(
        `Gemini service error (${status ?? 503}): ${sanitizedMessage}`,
        'GEMINI_SERVICE_ERROR',
        true
      );
    }

    throw new AIProviderError(
      `Gemini API generation error: ${sanitizedMessage}`,
      'GEMINI_API_ERROR',
      false
    );
  }

  private async executeWithRetryAndFallback<T>(
    executeFn: (modelName: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const modelsToTry = [this.defaultModel];
    if (this.fallbackModel && this.fallbackModel !== this.defaultModel) {
      modelsToTry.push(this.fallbackModel);
    }

    let lastError: unknown;

    for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
      const currentModel = modelsToTry[modelIndex];
      if (!currentModel) continue;

      const isFallback = modelIndex > 0;
      const retries = isFallback ? [0] : [0, ...this.retryDelaysMs];

      for (let attempt = 0; attempt < retries.length; attempt++) {
        this.checkAborted(signal);

        if (attempt > 0) {
          const delayMs = retries[attempt] ?? 800;
          await this.sleepWithSignal(delayMs, signal);
        }

        try {
          return await executeFn(currentModel);
        } catch (err: unknown) {
          if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
            throw err;
          }

          lastError = err;

          // If not a 503 / overloaded error, do not retry - throw immediately
          if (!this.isOverloadedOr503Error(err)) {
            this.handleError(err, signal);
          }
        }
      }
    }

    this.handleError(lastError, signal);
  }

  async generateResponse(options: GenerateOptions): Promise<GenerateResult> {
    this.checkAborted(options.signal);

    const { contents, systemInstruction } = this.formatMessages(options.messages);
    const configuredModel = options.config?.model as string | undefined;
    const temperature = options.config?.temperature;

    return this.executeWithRetryAndFallback(
      async (modelName) => {
        const modelToUse = configuredModel || modelName;
        const response = await this.client.models.generateContent({
          model: modelToUse,
          contents,
          config: {
            systemInstruction,
            temperature,
            abortSignal: options.signal,
          },
        });

        this.checkAborted(options.signal);

        const text = response.text ?? '';
        const usageMetadata = response.usageMetadata;

        return {
          text,
          usage: usageMetadata
            ? {
                promptTokens: usageMetadata.promptTokenCount ?? 0,
                completionTokens: usageMetadata.candidatesTokenCount ?? 0,
                totalTokens: usageMetadata.totalTokenCount ?? 0,
              }
            : undefined,
        };
      },
      options.signal
    );
  }

  async *streamResponse(options: StreamOptions): AsyncIterable<StreamChunk> {
    this.checkAborted(options.signal);

    const { contents, systemInstruction } = this.formatMessages(options.messages);
    const configuredModel = options.config?.model as string | undefined;
    const temperature = options.config?.temperature;

    const responseStream = await this.executeWithRetryAndFallback(
      async (modelName) => {
        const modelToUse = configuredModel || modelName;
        return await this.client.models.generateContentStream({
          model: modelToUse,
          contents,
          config: {
            systemInstruction,
            temperature,
            abortSignal: options.signal,
          },
        });
      },
      options.signal
    );

    this.checkAborted(options.signal);

    let index = 0;
    try {
      for await (const chunk of responseStream) {
        this.checkAborted(options.signal);

        const chunkText = chunk.text ?? '';
        if (chunkText.length > 0) {
          yield {
            text: chunkText,
            index: index++,
            isFinal: false,
          };
        }
      }
    } catch (err: unknown) {
      this.handleError(err, options.signal);
    }
  }
}
