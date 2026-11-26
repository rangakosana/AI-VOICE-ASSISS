import crypto from 'node:crypto';
import { SessionRepository } from '../db/repositories/sessionRepository.js';

export interface Session {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly createdAt: Date;
  status: 'active' | 'ended';
  userId?: string;
  endedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface SessionRegistryOptions {
  repository?: SessionRepository;
}

/**
 * Session Registry with SQLite Persistence
 *
 * Tracks live WebSocket connection mappings in memory while persisting
 * session lifecycle (creation, status updates, termination) to SQLite.
 */
export class SessionRegistry {
  private readonly repository: SessionRepository;
  private readonly sessions = new Map<string, Session>();
  private readonly connectionSessions = new Map<string, string>(); // connectionId -> active sessionId

  constructor(options: SessionRegistryOptions = {}) {
    this.repository = options.repository ?? new SessionRepository();
    // On initialization, ensure dangling active sessions from previous process runs are ended
    this.repository.markDanglingSessionsEndedOnStartup();
  }

  /**
   * Starts a new session associated with a connection identifier.
   * If an active session already exists on the connection, it is automatically ended first.
   */
  createSession(connectionId: string, metadata?: Record<string, unknown>, userId?: string): Session {
    const existingSessionId = this.connectionSessions.get(connectionId);
    if (existingSessionId) {
      this.endSession(existingSessionId, 'superseded_by_new_session');
    }

    const sessionId = crypto.randomUUID();
    const session: Session = {
      sessionId,
      connectionId,
      createdAt: new Date(),
      status: 'active',
      userId: userId?.trim() || 'default_user',
      metadata: metadata ? { ...metadata } : {},
    };

    this.sessions.set(sessionId, session);
    this.connectionSessions.set(connectionId, sessionId);
    this.repository.createSession(session);
    return session;
  }

  /**
   * Retrieves a session by its unique ID.
   * Checks in-memory cache first, falling back to SQLite.
   */
  getSession(sessionId: string): Session | undefined {
    const memSession = this.sessions.get(sessionId);
    if (memSession) return memSession;

    const dbSession = this.repository.getSession(sessionId);
    if (dbSession) {
      this.sessions.set(sessionId, dbSession);
    }
    return dbSession;
  }

  /**
   * Retrieves the currently active session for a specific connection.
   */
  getActiveSessionForConnection(connectionId: string): Session | undefined {
    const sessionId = this.connectionSessions.get(connectionId);
    if (!sessionId) return undefined;
    const session = this.getSession(sessionId);
    return session && session.status === 'active' ? session : undefined;
  }

  /**
   * Ends an active session.
   * Updates state in memory and persists termination timestamp and reason to SQLite.
   */
  endSession(sessionId: string, reason = 'client_requested'): Session | undefined {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'ended') {
      return undefined;
    }

    session.status = 'ended';
    session.endedAt = new Date();
    if (session.metadata) {
      session.metadata.endReason = reason;
    }

    if (this.connectionSessions.get(session.connectionId) === sessionId) {
      this.connectionSessions.delete(session.connectionId);
    }

    this.repository.endSession(sessionId, session.endedAt, session.metadata);

    return session;
  }

  /**
   * Cleans up all active sessions when a connection terminates unexpectedly or cleanly.
   */
  handleDisconnect(connectionId: string): void {
    const sessionId = this.connectionSessions.get(connectionId);
    if (sessionId) {
      this.endSession(sessionId, 'connection_terminated');
    }
  }

  /**
   * Returns current count of active connections in memory.
   */
  getActiveSessionCount(): number {
    return this.connectionSessions.size;
  }

  /**
   * Resets registry state (used primarily in test fixtures).
   */
  clear(): void {
    this.sessions.clear();
    this.connectionSessions.clear();
    this.repository.clearAllSessions();
  }
}

export const sessionRegistry = new SessionRegistry();
