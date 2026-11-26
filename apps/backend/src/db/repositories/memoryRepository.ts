import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../connection.js';

export type MemoryCategory = 'personal_fact' | 'preference' | 'goal' | 'context';
export type MemoryStatus = 'active' | 'suggested' | 'archived';
export type MemorySource = 'explicit_user' | 'assistant_suggested';

export interface MemoryRecord {
  readonly id: string;
  readonly userId: string;
  readonly category: MemoryCategory;
  readonly content: string;
  readonly source: MemorySource;
  readonly status: MemoryStatus;
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateMemoryInput {
  userId?: string;
  category: MemoryCategory;
  content: string;
  source?: MemorySource;
  status?: MemoryStatus;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  status?: MemoryStatus;
  metadata?: Record<string, unknown>;
}

export interface ListMemoriesFilter {
  userId?: string;
  category?: MemoryCategory;
  status?: MemoryStatus;
  search?: string;
  limit?: number;
}

interface MemoryRow {
  id: string;
  user_id: string;
  category: string;
  content: string;
  source: string;
  status: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

const VALID_CATEGORIES = new Set<MemoryCategory>([
  'personal_fact',
  'preference',
  'goal',
  'context',
]);

const VALID_STATUSES = new Set<MemoryStatus>([
  'active',
  'suggested',
  'archived',
]);

const VALID_SOURCES = new Set<MemorySource>([
  'explicit_user',
  'assistant_suggested',
]);

export const DEFAULT_USER_ID = 'default_user';
const MAX_CONTENT_LENGTH = 1000;

function validateCategory(category: unknown): asserts category is MemoryCategory {
  if (typeof category !== 'string' || !VALID_CATEGORIES.has(category as MemoryCategory)) {
    throw new Error(
      `Invalid memory category "${String(category)}". Supported categories: ${Array.from(VALID_CATEGORIES).join(', ')}`
    );
  }
}

function validateStatus(status: unknown): asserts status is MemoryStatus {
  if (typeof status !== 'string' || !VALID_STATUSES.has(status as MemoryStatus)) {
    throw new Error(
      `Invalid memory status "${String(status)}". Supported statuses: ${Array.from(VALID_STATUSES).join(', ')}`
    );
  }
}

function validateSource(source: unknown): asserts source is MemorySource {
  if (typeof source !== 'string' || !VALID_SOURCES.has(source as MemorySource)) {
    throw new Error(
      `Invalid memory source "${String(source)}". Supported sources: ${Array.from(VALID_SOURCES).join(', ')}`
    );
  }
}

function validateContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new Error('Memory content must be a string.');
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error('Memory content cannot be empty.');
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Memory content cannot exceed ${MAX_CONTENT_LENGTH} characters (received ${trimmed.length}).`);
  }
  return trimmed;
}

function mapRowToRecord(row: MemoryRow): MemoryRecord {
  let parsedMetadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      parsedMetadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      parsedMetadata = undefined;
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    category: row.category as MemoryCategory,
    content: row.content,
    source: row.source as MemorySource,
    status: row.status as MemoryStatus,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parsedMetadata,
  };
}

/**
 * SQLite Personal Memory Repository
 *
 * Manages storage, retrieval, filtering, updates, and hard deletion of user memories.
 * Designed for user/profile ownership while remaining single-user-compatible by default.
 */
export class MemoryRepository {
  private readonly db: Database.Database;
  private readonly insertMemoryStmt: Database.Statement;
  private readonly getMemoryStmt: Database.Statement;
  private readonly updateMemoryStmt: Database.Statement;
  private readonly deleteMemoryStmt: Database.Statement;
  private readonly clearAllStmt: Database.Statement;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();

    this.insertMemoryStmt = this.db.prepare(`
      INSERT INTO memories (
        id, user_id, category, content, source, status, session_id, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getMemoryStmt = this.db.prepare(`
      SELECT id, user_id, category, content, source, status, session_id, created_at, updated_at, metadata
      FROM memories
      WHERE id = ? AND user_id = ?
    `);

    this.updateMemoryStmt = this.db.prepare(`
      UPDATE memories
      SET content = ?, category = ?, status = ?, updated_at = ?, metadata = ?
      WHERE id = ? AND user_id = ?
    `);

    this.deleteMemoryStmt = this.db.prepare(`
      DELETE FROM memories
      WHERE id = ? AND user_id = ?
    `);

    this.clearAllStmt = this.db.prepare(`
      DELETE FROM memories
    `);
  }

  /**
   * Creates and stores a new memory record with a backend-generated UUID.
   * Client-provided IDs are never trusted or accepted.
   */
  createMemory(input: CreateMemoryInput): MemoryRecord {
    const category = input.category;
    validateCategory(category);

    const status = input.status ?? 'active';
    validateStatus(status);

    const source = input.source ?? 'explicit_user';
    validateSource(source);

    const content = validateContent(input.content);
    const userId = input.userId?.trim() || DEFAULT_USER_ID;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadataStr = input.metadata ? JSON.stringify(input.metadata) : null;

    this.insertMemoryStmt.run(
      id,
      userId,
      category,
      content,
      source,
      status,
      input.sessionId ?? null,
      now,
      now,
      metadataStr
    );

    return {
      id,
      userId,
      category,
      content,
      source,
      status,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };
  }

  /**
   * Retrieves a memory by ID for a specific user/profile.
   */
  getMemory(id: string, userId = DEFAULT_USER_ID): MemoryRecord | undefined {
    const row = this.getMemoryStmt.get(id, userId) as MemoryRow | undefined;
    if (!row) return undefined;
    return mapRowToRecord(row);
  }

  /**
   * Lists and filters memories for a user/profile.
   * Supports filtering by category, status, search substring, and limiting results.
   */
  listMemories(filter: ListMemoriesFilter = {}): readonly MemoryRecord[] {
    const userId = filter.userId?.trim() || DEFAULT_USER_ID;

    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];

    if (filter.category) {
      validateCategory(filter.category);
      conditions.push('category = ?');
      params.push(filter.category);
    }

    if (filter.status) {
      validateStatus(filter.status);
      conditions.push('status = ?');
      params.push(filter.status);
    }

    if (filter.search && filter.search.trim().length > 0) {
      conditions.push('content LIKE ?');
      params.push(`%${filter.search.trim()}%`);
    }

    let sql = `
      SELECT id, user_id, category, content, source, status, session_id, created_at, updated_at, metadata
      FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, rowid DESC
    `;

    if (typeof filter.limit === 'number' && filter.limit > 0) {
      sql += ' LIMIT ?';
      params.push(Math.floor(filter.limit));
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(mapRowToRecord);
  }

  /**
   * Updates an existing memory record.
   * Automatically refreshes the `updated_at` timestamp.
   */
  updateMemory(id: string, update: UpdateMemoryInput, userId = DEFAULT_USER_ID): MemoryRecord | undefined {
    const existing = this.getMemory(id, userId);
    if (!existing) {
      return undefined;
    }

    let newContent = existing.content;
    if (update.content !== undefined) {
      newContent = validateContent(update.content);
    }

    let newCategory = existing.category;
    if (update.category !== undefined) {
      validateCategory(update.category);
      newCategory = update.category;
    }

    let newStatus = existing.status;
    if (update.status !== undefined) {
      validateStatus(update.status);
      newStatus = update.status;
    }

    const newMetadata = update.metadata !== undefined ? update.metadata : existing.metadata;
    const newUpdatedAt = new Date().toISOString();
    const metadataStr = newMetadata ? JSON.stringify(newMetadata) : null;

    this.updateMemoryStmt.run(
      newContent,
      newCategory,
      newStatus,
      newUpdatedAt,
      metadataStr,
      id,
      userId
    );

    return {
      ...existing,
      content: newContent,
      category: newCategory,
      status: newStatus,
      updatedAt: newUpdatedAt,
      metadata: newMetadata ? { ...newMetadata } : undefined,
    };
  }

  /**
   * Hard-deletes a memory record permanently by ID.
   * Returns true if a row was deleted, false otherwise.
   */
  deleteMemory(id: string, userId = DEFAULT_USER_ID): boolean {
    const result = this.deleteMemoryStmt.run(id, userId);
    return result.changes > 0;
  }

  /**
   * Counts memories matching optional category and status filters.
   */
  countMemories(filter: { userId?: string; category?: MemoryCategory; status?: MemoryStatus } = {}): number {
    const userId = filter.userId?.trim() || DEFAULT_USER_ID;
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];

    if (filter.category) {
      validateCategory(filter.category);
      conditions.push('category = ?');
      params.push(filter.category);
    }

    if (filter.status) {
      validateStatus(filter.status);
      conditions.push('status = ?');
      params.push(filter.status);
    }

    const sql = `SELECT COUNT(*) AS count FROM memories WHERE ${conditions.join(' AND ')}`;
    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Clears all memories from the database (for testing teardowns).
   */
  clearAllMemories(): void {
    this.clearAllStmt.run();
  }
}

