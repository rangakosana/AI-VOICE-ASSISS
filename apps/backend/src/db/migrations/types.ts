import type Database from 'better-sqlite3';

/**
 * Interface representing a database migration.
 */
export interface Migration {
  readonly id: string;
  readonly description: string;
  readonly up: (db: Database.Database) => void;
  readonly down?: (db: Database.Database) => void;
}

