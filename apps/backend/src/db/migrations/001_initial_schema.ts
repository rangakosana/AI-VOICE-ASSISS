import type { Migration } from './types.js';

/**
 * Migration 001: Initial schema for ATLAS.
 * Creates the foundational sessions and messages tables with indexes and foreign keys.
 */
export const migration001: Migration = {
  id: '001_initial_schema',
  description: 'Create sessions and messages tables with indexes and foreign keys',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'ended')),
        ended_at TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
    `);
  },
};

