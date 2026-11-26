import crypto from 'node:crypto';
import { conversationHistory, type ConversationHistoryManager } from './conversationHistory.js';
import { createAIProvider } from './providerFactory.js';
import { memoryService, type MemoryService } from '../memory/index.js';
import { recallService, type RecallService } from '../recall/index.js';
import type { AIProvider, ChatMessage } from './types.js';

export interface GenerationCallbacks {
  onStart: (responseId: string) => void;
  onDelta: (chunk: string, index: number, responseId: string) => void;
  onComplete: (fullText: string, responseId: string) => void;
  onCancelled: (responseId?: string) => void;
  onError: (err: Error) => void;
}

export interface ConversationEngineOptions {
  defaultProvider?: AIProvider;
  historyManager?: ConversationHistoryManager;
  memoryService?: MemoryService;
  recallService?: RecallService;
}

interface ActiveGenerationEntry {
  controller: AbortController;
  responseId: string;
  requestId?: string;
  userMessageId: string;
}

/**
 * Core Conversation Engine
 *
 * Orchestrates dialogue turns, session history, and provider-agnostic LLM calls.
 * Decoupled completely from transport protocols (WebSockets, REST, CLI).
 */
export class ConversationEngine {
  private defaultProvider: AIProvider;
  private readonly history: ConversationHistoryManager;
  private readonly memoryService?: MemoryService;
  private readonly recallService?: RecallService;
  private readonly activeControllers = new Map<string, ActiveGenerationEntry>();

  constructor(options: ConversationEngineOptions = {}) {
    this.defaultProvider = options.defaultProvider ?? createAIProvider();
    this.history = options.historyManager ?? conversationHistory;
    this.memoryService = 'memoryService' in options ? options.memoryService : memoryService;
    this.recallService = 'recallService' in options ? options.recallService : recallService;
  }

  /**
   * Returns the current active AI provider.
   */
  getProvider(): AIProvider {
    return this.defaultProvider;
  }

  /**
   * Updates or switches the active AI provider.
   */
  setProvider(provider: AIProvider): void {
    this.defaultProvider = provider;
  }

  /**
   * Checks whether a generation is actively running for a given session.
   */
  hasActiveGeneration(sessionId: string): boolean {
    return this.activeControllers.has(sessionId);
  }

  /**
   * Returns the requestId associated with the currently active generation, if any.
   */
  getActiveRequestId(sessionId: string): string | undefined {
    return this.activeControllers.get(sessionId)?.requestId;
  }

  /**
   * Cancels any in-flight generation for the specified session.
   * If a requestId is specified, only cancels if the active generation matches that requestId.
   * Returns true if an active generation was aborted.
   */
  cancelGeneration(sessionId: string, requestId?: string): boolean {
    const active = this.activeControllers.get(sessionId);
    if (!active) {
      return false;
    }

    // If a specific requestId was targeted, ensure it matches
    if (requestId && active.requestId && active.requestId !== requestId) {
      return false;
    }

    active.controller.abort();
    this.activeControllers.delete(sessionId);
    return true;
  }

  /**
   * Processes an incoming user message within a session context.
   * Rejects concurrent requests in the same session with an error.
   */
  async processUserMessage(
    sessionId: string,
    userText: string,
    callbacks: GenerationCallbacks,
    options: { requestId?: string; provider?: AIProvider; userId?: string } = {}
  ): Promise<void> {
    // 1. Predictable concurrency policy: Reject concurrent requests within the same session
    if (this.hasActiveGeneration(sessionId)) {
      throw new Error(
        'CONCURRENT_REQUEST_NOT_ALLOWED: An active generation is already in progress for this session.'
      );
    }

    // 2. Append user message to the session's conversation history
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      timestamp: new Date().toISOString(),
    };
    this.history.addMessage(sessionId, userMessage);

    // 3. Setup AbortController for cancellation
    const controller = new AbortController();
    const responseId = crypto.randomUUID();
    this.activeControllers.set(sessionId, {
      controller,
      responseId,
      requestId: options.requestId,
      userMessageId: userMessage.id,
    });

    const provider = options.provider ?? this.defaultProvider;

    try {
      callbacks.onStart(responseId);

      // 4. Retrieve complete conversation context for this session
      const historyMessages = this.history.getHistory(sessionId);

      // 4b. Retrieve active memory context once per request (ephemeral, not saved to history)
      let memoryContext: string | undefined;
      if (this.memoryService) {
        try {
          memoryContext = this.memoryService.buildMemoryPromptContext(options.userId);
        } catch (memErr: unknown) {
          // If memory retrieval fails, safely roll back user turn and report error
          this.history.removeMessage(sessionId, userMessage.id);
          const error = memErr instanceof Error ? memErr : new Error(String(memErr));
          callbacks.onError(error);
          return;
        }
      }

      // 4c. Retrieve historical conversation recall context once per request (ephemeral, not saved to history)
      let recallContext: string | undefined;
      if (this.recallService) {
        try {
          recallContext = this.recallService.buildRecallPromptContext({
            query: userText,
            currentSessionId: sessionId,
            userId: options.userId,
          });
        } catch (recallErr: unknown) {
          // If recall retrieval fails, safely roll back user turn and report error
          this.history.removeMessage(sessionId, userMessage.id);
          const error = recallErr instanceof Error ? recallErr : new Error(String(recallErr));
          callbacks.onError(error);
          return;
        }
      }

      // 4d. Assemble combined ephemeral system messages in strict order:
      // 1. Existing system instructions (handled by AIProvider)
      // 2. Personal Memory context (Milestone 7B)
      // 3. Historical Conversation Recall context (Milestone 7C)
      // 4. Actual conversation history, including the current user message
      const ephemeralSystemMessages: ChatMessage[] = [];

      if (memoryContext) {
        ephemeralSystemMessages.push({
          id: 'ephemeral-memory-context',
          role: 'system',
          content: memoryContext,
          timestamp: new Date().toISOString(),
        });
      }

      if (recallContext) {
        ephemeralSystemMessages.push({
          id: 'ephemeral-recall-context',
          role: 'system',
          content: recallContext,
          timestamp: new Date().toISOString(),
        });
      }

      const messagesForAI: readonly ChatMessage[] = [
        ...ephemeralSystemMessages,
        ...historyMessages,
      ];

      let fullText = '';
      const stream = provider.streamResponse({
        messages: messagesForAI,
        signal: controller.signal,
      });

      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          // Roll back incomplete user message on cancellation
          this.history.removeMessage(sessionId, userMessage.id);
          callbacks.onCancelled(responseId);
          return;
        }

        fullText += chunk.text;
        callbacks.onDelta(chunk.text, chunk.index, responseId);
      }

      if (controller.signal.aborted) {
        this.history.removeMessage(sessionId, userMessage.id);
        callbacks.onCancelled(responseId);
        return;
      }

      // 5. Store completed assistant reply in conversation history
      const assistantMessage: ChatMessage = {
        id: responseId,
        role: 'assistant',
        content: fullText,
        timestamp: new Date().toISOString(),
      };
      this.history.addMessage(sessionId, assistantMessage);

      callbacks.onComplete(fullText, responseId);
    } catch (err: unknown) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        // Roll back incomplete user message on cancellation
        this.history.removeMessage(sessionId, userMessage.id);
        callbacks.onCancelled(responseId);
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onError(error);
    } finally {
      // Clean up active controller entry if it still points to this response
      const current = this.activeControllers.get(sessionId);
      if (current && current.responseId === responseId) {
        this.activeControllers.delete(sessionId);
      }
    }
  }

  /**
   * Cleans up all resources when a session terminates.
   */
  cleanupSession(sessionId: string): void {
    this.cancelGeneration(sessionId);
    this.history.clearHistory(sessionId);
  }

  /**
   * Resets all internal state (for testing).
   */
  clear(): void {
    for (const { controller } of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.history.clearAll();
  }
}

export const conversationEngine = new ConversationEngine();
