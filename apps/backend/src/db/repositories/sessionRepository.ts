import type Database from 'better-sqlite3';
import { getDatabase } from '../connection.js';
import type { Session } from '../../services/sessionRegistry.js';

interface SessionRow {
  id: string;
  connection_id: string;
  created_at: string;
  status: string;
  ended_at: string | null;
  metadata: string | null;
  user_id?: string;
}

/**
 * SQLite Session Repository
 *
 * Manages persistent storage and status updates for conversational sessions.
 */
export class SessionRepository {
  private readonly db: Database.Database;
  private readonly insertSessionStmt: Database.Statement;
  private readonly getSessionStmt: Database.Statement;
  private readonly endSessionStmt: Database.Statement;
  private readonly markDanglingStmt: Database.Statement;
  private readonly deleteSessionStmt: Database.Statement;
  private readonly clearAllStmt: Database.Statement;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();

    this.insertSessionStmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, connection_id, created_at, status, ended_at, metadata, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.getSessionStmt = this.db.prepare(`
      SELECT id, connection_id, created_at, status, ended_at, metadata, user_id
      FROM sessions
      WHERE id = ?
    `);

    this.endSessionStmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'ended', ended_at = ?, metadata = ?
      WHERE id = ? AND status = 'active'
    `);

    this.markDanglingStmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'ended', ended_at = ?
      WHERE status = 'active'
    `);

    this.deleteSessionStmt = this.db.prepare(`
      DELETE FROM sessions
      WHERE id = ?
    `);

    this.clearAllStmt = this.db.prepare(`
      DELETE FROM sessions
    `);
  }

  /**
   * Persists a session record into SQLite.
   */
  createSession(session: Session): void {
    this.insertSessionStmt.run(
      session.sessionId,
      session.connectionId,
      session.createdAt.toISOString(),
      session.status,
      session.endedAt ? session.endedAt.toISOString() : null,
      session.metadata ? JSON.stringify(session.metadata) : null,
      session.userId ?? 'default_user'
    );
  }

  /**
   * Retrieves a session record by its unique ID.
   */
  getSession(sessionId: string): Session | undefined {
    const row = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
    if (!row) return undefined;

    let parsedMetadata: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        parsedMetadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        parsedMetadata = {};
      }
    }

    return {
      sessionId: row.id,
      connectionId: row.connection_id,
      createdAt: new Date(row.created_at),
      status: row.status as 'active' | 'ended',
      userId: row.user_id ?? 'default_user',
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
      metadata: parsedMetadata,
    };
  }

  /**
   * Marks an active session as ended in SQLite with timestamp and metadata.
   */
  endSession(sessionId: string, endedAt: Date, metadata?: Record<string, unknown>): boolean {
    const result = this.endSessionStmt.run(
      endedAt.toISOString(),
      metadata ? JSON.stringify(metadata) : null,
      sessionId
    );
    return result.changes > 0;
  }

  /**
   * Cleans up dangling sessions from previous backend runs on startup.
   * Ensures old sessions are not treated as active after a restart.
   */
  markDanglingSessionsEndedOnStartup(): number {
    const result = this.markDanglingStmt.run(new Date().toISOString());
    return result.changes;
  }

  /**
   * Deletes a session by ID (cascades to all messages).
   */
  deleteSession(sessionId: string): boolean {
    const result = this.deleteSessionStmt.run(sessionId);
    return result.changes > 0;
  }

  /**
   * Clears all session records (used for test isolation).
   */
  clearAllSessions(): void {
    this.clearAllStmt.run();
  }
}

