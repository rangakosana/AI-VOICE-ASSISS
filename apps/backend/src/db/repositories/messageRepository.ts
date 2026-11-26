import type Database from 'better-sqlite3';
import { getDatabase } from '../connection.js';
import type { ChatMessage, MessageRole } from '../../services/ai/types.js';

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
}

/**
 * SQLite Message Repository
 *
 * Handles persistent storage, retrieval, and turn rollback for conversation messages.
 * Guarantees strict session scoping on all queries.
 */
export class MessageRepository {
  private readonly db: Database.Database;
  private readonly insertMessageStmt: Database.Statement;
  private readonly ensureSessionStmt: Database.Statement;
  private readonly getSessionMessagesStmt: Database.Statement;
  private readonly deleteMessageStmt: Database.Statement;
  private readonly clearSessionMessagesStmt: Database.Statement;
  private readonly countMessagesStmt: Database.Statement;
  private readonly clearAllStmt: Database.Statement;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();

    // Cache prepared statements for sub-millisecond execution
    this.ensureSessionStmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, connection_id, created_at, status, user_id)
      VALUES (?, 'system', ?, 'active', 'default_user')
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getSessionMessagesStmt = this.db.prepare(`
      SELECT id, session_id, role, content, created_at AS timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY rowid ASC
    `);

    this.deleteMessageStmt = this.db.prepare(`
      DELETE FROM messages
      WHERE session_id = ? AND id = ?
    `);

    this.clearSessionMessagesStmt = this.db.prepare(`
      DELETE FROM messages
      WHERE session_id = ?
    `);

    this.countMessagesStmt = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE session_id = ?
    `);

    this.clearAllStmt = this.db.prepare(`
      DELETE FROM messages
    `);
  }

  /**
   * Persists a chat message for a session.
   * Automatically satisfies foreign key constraints if the session row does not yet exist.
   */
  addMessage(sessionId: string, message: ChatMessage): void {
    const now = new Date().toISOString();
    this.ensureSessionStmt.run(sessionId, now);

    this.insertMessageStmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp || now
    );
  }

  /**
   * Retrieves all messages for a session in guaranteed chronological order.
   */
  getMessagesBySessionId(sessionId: string): readonly ChatMessage[] {
    const rows = this.getSessionMessagesStmt.all(sessionId) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Removes a specific message by ID within a session.
   * Used for rolling back incomplete user/assistant turns on cancellation.
   */
  removeMessage(sessionId: string, messageId: string): boolean {
    const result = this.deleteMessageStmt.run(sessionId, messageId);
    return result.changes > 0;
  }

  /**
   * Deletes all messages belonging to a specific session.
   */
  clearMessagesBySessionId(sessionId: string): void {
    this.clearSessionMessagesStmt.run(sessionId);
  }

  /**
   * Returns the total count of messages for a session.
   */
  countMessages(sessionId: string): number {
    const row = this.countMessagesStmt.get(sessionId) as { count: number } | undefined;
    return row ? row.count : 0;
  }

  /**
   * Clears all messages across all sessions (used for test isolation).
   */
  clearAllMessages(): void {
    this.clearAllStmt.run();
  }
}

