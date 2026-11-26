import type { Migration } from './types.js';

/**
 * Migration 002: Personal Memories Schema.
 * Creates the memories table with user ownership, categorization, status, and indexes.
 */
export const migration002: Migration = {
  id: '002_memories_schema',
  description: 'Create memories table with user ownership, categorization, and indexes',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default_user',
        category TEXT NOT NULL CHECK(category IN ('personal_fact', 'preference', 'goal', 'context')),
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('explicit_user', 'assistant_suggested')),
        status TEXT NOT NULL CHECK(status IN ('active', 'suggested', 'archived')),
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_user_status_category ON memories(user_id, status, category);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS memories;
    `);
  },
};

