import type Database from 'better-sqlite3';
import { getDatabase } from '../connection.js';
import { DEFAULT_USER_ID } from './memoryRepository.js';
import type { MessageRole } from '../../services/ai/types.js';

export interface RecalledMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface RecalledExchange {
  readonly matchedMessage: RecalledMessage;
  readonly rank: number;
  readonly exchangeMessages: readonly RecalledMessage[];
  readonly sessionCreatedAt?: string;
}

export interface RecallSearchParams {
  readonly query: string;
  readonly currentSessionId?: string;
  readonly userId?: string;
  readonly limit?: number;
  readonly neighborCount?: number;
}

interface RawMatchedRow {
  rowid: number;
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  user_id: string;
  session_created_at: string | null;
  rank: number;
}

interface RawNeighborRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

/**
 * Safely extracts alphanumeric and unicode tokens from a user query string,
 * escaping internal quotes and joining with 'OR' for FTS5 BM25 ranked matching.
 * Returns an empty string if query contains no valid search tokens.
 */
export function tokenizeFts5Query(query: string): string {
  if (!query || typeof query !== 'string') {
    return '';
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return '';
  }

  // Extract unicode word tokens (letters, digits, underscores, hyphens)
  const rawTokens = trimmed.match(/[\p{L}\p{N}_-]+/gu);
  if (!rawTokens || rawTokens.length === 0) {
    return '';
  }

  // Strip leading/trailing hyphens or underscores
  const validTokens = rawTokens
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ''))
    .filter((t) => t.length > 0);

  if (validTokens.length === 0) {
    return '';
  }

  // Escape internal double quotes and wrap each token in quotes
  return validTokens
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' OR ');
}

/**
 * SQLite Conversation Recall Repository
 *
 * Implements local, persistent, cross-session search of historical conversations
 * using SQLite FTS5 with BM25 ranking, session exclusion, user scoping, and
 * neighboring dialogue exchange expansion.
 */
export class RecallRepository {
  private readonly db: Database.Database;
  private readonly searchWithExcludeStmt: Database.Statement;
  private readonly searchWithoutExcludeStmt: Database.Statement;
  private readonly getPrecedingNeighborsStmt: Database.Statement;
  private readonly getFollowingNeighborsStmt: Database.Statement;
  private readonly countFtsEntriesStmt: Database.Statement;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();

    this.searchWithExcludeStmt = this.db.prepare(`
      SELECT
        m.rowid,
        m.id,
        m.session_id,
        m.role,
        m.content,
        m.created_at,
        s.user_id,
        s.created_at AS session_created_at,
        fts.rank
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.message_id
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
        AND s.user_id = ?
        AND m.session_id != ?
      ORDER BY fts.rank ASC
      LIMIT ?
    `);

    this.searchWithoutExcludeStmt = this.db.prepare(`
      SELECT
        m.rowid,
        m.id,
        m.session_id,
        m.role,
        m.content,
        m.created_at,
        s.user_id,
        s.created_at AS session_created_at,
        fts.rank
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.message_id
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
        AND s.user_id = ?
      ORDER BY fts.rank ASC
      LIMIT ?
    `);

    this.getPrecedingNeighborsStmt = this.db.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM messages
      WHERE session_id = ? AND rowid < ?
      ORDER BY rowid DESC
      LIMIT ?
    `);

    this.getFollowingNeighborsStmt = this.db.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM messages
      WHERE session_id = ? AND rowid > ?
      ORDER BY rowid ASC
      LIMIT ?
    `);

    this.countFtsEntriesStmt = this.db.prepare(`
      SELECT count(*) AS count FROM messages_fts
    `);
  }

  /**
   * Searches historical messages using FTS5 BM25 ranking, excludes the current session,
   * enforces user ownership, and fetches neighboring messages for conversational context.
   */
  searchHistoricalExchanges(params: RecallSearchParams): readonly RecalledExchange[] {
    const ftsQuery = tokenizeFts5Query(params.query);
    if (!ftsQuery) {
      return [];
    }

    const targetUserId = params.userId?.trim() || DEFAULT_USER_ID;
    const limit = Math.max(1, Math.min(params.limit ?? 5, 50));
    const neighborCount = Math.max(0, Math.min(params.neighborCount ?? 1, 5));
    const excludeSessionId = params.currentSessionId?.trim();

    // Query extra candidates to guarantee sufficient results after exchange deduplication
    const candidateLimit = limit * 3;

    const matchedRows = (
      excludeSessionId
        ? this.searchWithExcludeStmt.all(ftsQuery, targetUserId, excludeSessionId, candidateLimit)
        : this.searchWithoutExcludeStmt.all(ftsQuery, targetUserId, candidateLimit)
    ) as RawMatchedRow[];

    if (matchedRows.length === 0) {
      return [];
    }

    const seenMessageIds = new Set<string>();
    const exchanges: RecalledExchange[] = [];

    for (const match of matchedRows) {
      // Deduplicate if this message is already part of a previously assembled exchange
      if (seenMessageIds.has(match.id)) {
        continue;
      }

      // Fetch preceding neighbor messages within the same session
      const precedingRows = (
        neighborCount > 0
          ? (this.getPrecedingNeighborsStmt.all(
              match.session_id,
              match.rowid,
              neighborCount
            ) as RawNeighborRow[])
          : []
      ).reverse();

      // Fetch following neighbor messages within the same session
      const followingRows =
        neighborCount > 0
          ? (this.getFollowingNeighborsStmt.all(
              match.session_id,
              match.rowid,
              neighborCount
            ) as RawNeighborRow[])
          : [];

      const exchangeMessages: RecalledMessage[] = [
        ...precedingRows.map((r) => ({
          id: r.id,
          sessionId: r.session_id,
          role: r.role as MessageRole,
          content: r.content,
          createdAt: r.created_at,
        })),
        {
          id: match.id,
          sessionId: match.session_id,
          role: match.role as MessageRole,
          content: match.content,
          createdAt: match.created_at,
        },
        ...followingRows.map((r) => ({
          id: r.id,
          sessionId: r.session_id,
          role: r.role as MessageRole,
          content: r.content,
          createdAt: r.created_at,
        })),
      ];

      // Mark all messages in this exchange as seen to prevent duplicate snippet reporting
      for (const msg of exchangeMessages) {
        seenMessageIds.add(msg.id);
      }

      exchanges.push({
        matchedMessage: {
          id: match.id,
          sessionId: match.session_id,
          role: match.role as MessageRole,
          content: match.content,
          createdAt: match.created_at,
        },
        rank: match.rank,
        exchangeMessages,
        sessionCreatedAt: match.session_created_at ?? undefined,
      });

      if (exchanges.length >= limit) {
        break;
      }
    }

    return exchanges;
  }

  /**
   * Returns the count of entries in the messages_fts virtual table (primarily for verification).
   */
  countFtsEntries(): number {
    const row = this.countFtsEntriesStmt.get() as { count: number } | undefined;
    return row ? row.count : 0;
  }

  /**
   * Rebuilds the FTS index from scratch (maintenance utility).
   */
  rebuildFtsIndex(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  }
}
