import type Database from 'better-sqlite3';
import type { Migration } from './types.js';

/**
 * Asserts that the SQLite engine has the FTS5 extension compiled and available.
 * Throws a descriptive and actionable error if FTS5 is missing.
 */
export function assertFts5Available(db: Database.Database): void {
  try {
    const compileOption = db
      .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
      .get() as { enabled: number } | undefined;
    if (compileOption?.enabled === 1) {
      return;
    }
  } catch {
    // If compile option check throws, fall back to temporary virtual table probe
  }

  try {
    db.exec('CREATE VIRTUAL TABLE temp._fts5_check USING fts5(probe); DROP TABLE temp._fts5_check;');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite FTS5 extension is not available in the current SQLite engine. ` +
      `ATLAS Conversation Recall requires SQLite with FTS5 enabled. Details: ${msg}`
    );
  }
}

/**
 * Migration 003: Conversation Recall Schema.
 *
 * Adds user ownership to sessions, creates the messages_fts virtual table for full-text
 * BM25 search, backfills existing messages, and installs synchronization triggers.
 */
export const migration003: Migration = {
  id: '003_conversation_recall',
  description: 'Add user_id to sessions, create messages_fts virtual table, triggers, and backfill',
  up: (db) => {
    // 1. Verify FTS5 availability before performing schema alterations
    assertFts5Available(db);

    // 2. Add user_id column to sessions if not already present
    const sessionColumns = db.pragma('table_info(sessions)') as Array<{ name: string }>;
    const hasUserId = sessionColumns.some((col) => col.name === 'user_id');
    if (!hasUserId) {
      db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';");
    }

    // 3. Create indexes for user session lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);
    `);

    // 4. Create FTS5 virtual table for messages full-text search
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);

    // 5. Install synchronization triggers to maintain messages_fts
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(message_id, session_id, role, content)
        VALUES (new.id, new.session_id, new.role, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
        INSERT INTO messages_fts(message_id, session_id, role, content)
        VALUES (new.id, new.session_id, new.role, new.content);
      END;
    `);

    // 6. Backfill existing messages that are not yet in messages_fts
    db.exec(`
      INSERT INTO messages_fts (message_id, session_id, role, content)
      SELECT id, session_id, role, content FROM messages
      WHERE id NOT IN (SELECT message_id FROM messages_fts);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_messages_au;
      DROP TRIGGER IF EXISTS trg_messages_ad;
      DROP TRIGGER IF EXISTS trg_messages_ai;
      DROP TABLE IF EXISTS messages_fts;
      DROP INDEX IF EXISTS idx_sessions_user_status;
      DROP INDEX IF EXISTS idx_sessions_user;
    `);
  },
};

