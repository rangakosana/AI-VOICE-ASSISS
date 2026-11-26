import type Database from 'better-sqlite3';
import { MessageRepository } from '../../db/repositories/messageRepository.js';
import type { ChatMessage } from './types.js';

export interface ConversationHistoryManagerOptions {
  messageRepository?: MessageRepository;
  db?: Database.Database;
}

/**
 * SQLite-Backed Conversation History Manager
 *
 * Implements the conversation history manager interface backed by the SQLite MessageRepository.
 * Guarantees strict session isolation, persistent storage across restarts, and chronological turn order.
 */
export class ConversationHistoryManager {
  private readonly repository: MessageRepository;

  constructor(options: ConversationHistoryManagerOptions = {}) {
    if (options.messageRepository) {
      this.repository = options.messageRepository;
    } else if (options.db) {
      this.repository = new MessageRepository(options.db);
    } else {
      this.repository = new MessageRepository();
    }
  }

  /**
   * Appends a message to the session's conversation history in SQLite.
   */
  addMessage(sessionId: string, message: ChatMessage): void {
    this.repository.addMessage(sessionId, message);
  }

  /**
   * Retrieves an immutable snapshot of messages for a given session in chronological order.
   */
  getHistory(sessionId: string): readonly ChatMessage[] {
    return this.repository.getMessagesBySessionId(sessionId);
  }

  /**
   * Returns the count of messages in a session.
   */
  getMessageCount(sessionId: string): number {
    return this.repository.countMessages(sessionId);
  }

  /**
   * Removes a specific message by ID from a session's history.
   * Used to roll back incomplete turns when generation is aborted.
   */
  removeMessage(sessionId: string, messageId: string): boolean {
    return this.repository.removeMessage(sessionId, messageId);
  }

  /**
   * Clears history for a specific session (e.g. when session ends).
   */
  clearHistory(sessionId: string): void {
    this.repository.clearMessagesBySessionId(sessionId);
  }

  /**
   * Clears all session histories (used for test isolation).
   */
  clearAll(): void {
    this.repository.clearAllMessages();
  }
}

export const conversationHistory = new ConversationHistoryManager();
