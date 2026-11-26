import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/index.js';
import { runMigrations, type MigrationResult } from './migrations/index.js';

export interface DatabaseConnectionOptions {
  path?: string;
  readonly?: boolean;
  timeout?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export interface DatabaseInitOptions extends DatabaseConnectionOptions {
  autoMigrate?: boolean;
}

/**
 * Creates and configures a SQLite database connection with mandatory ATLAS pragmas:
 * - PRAGMA foreign_keys = ON
 * - PRAGMA busy_timeout = 5000
 * - PRAGMA journal_mode = WAL
 */
export function createDatabaseConnection(
  options: DatabaseConnectionOptions = {}
): Database.Database {
  const dbPath = options.path ?? config.databasePath;

  // Create parent directory if path is not :memory:
  if (dbPath !== ':memory:') {
    const parentDir = path.dirname(dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new Database(dbPath, {
    readonly: options.readonly ?? false,
    timeout: options.timeout ?? 5000,
    verbose: options.verbose,
  });

  // 1. Mandatory foreign key constraint enforcement
  db.pragma('foreign_keys = ON');

  // 2. Set busy timeout to prevent immediate SQLITE_BUSY locking errors
  db.pragma('busy_timeout = 5000');

  // 3. Enable WAL mode for high concurrency
  db.pragma('journal_mode = WAL');

  return db;
}

let globalDb: Database.Database | null = null;

/**
 * Initializes a database connection and runs pending migrations.
 */
export function initDatabase(options: DatabaseInitOptions = {}): {
  db: Database.Database;
  migrations: MigrationResult;
} {
  const db = createDatabaseConnection(options);
  let migrations: MigrationResult = { applied: [], skipped: [], totalApplied: 0 };

  if (options.autoMigrate !== false) {
    migrations = runMigrations(db);
  }

  return { db, migrations };
}

/**
 * Returns or initializes the global singleton database instance.
 */
export function getDatabase(): Database.Database {
  if (!globalDb || !globalDb.open) {
    const { db } = initDatabase();
    globalDb = db;
  }
  return globalDb;
}

/**
 * Closes a database connection cleanly, checkpointing WAL logs if disk-based.
 */
export function closeDatabase(db?: Database.Database): void {
  const target = db ?? globalDb;
  if (target && target.open) {
    try {
      target.close();
    } catch {
      // Ignore if already closing or closed
    }
    if (target === globalDb) {
      globalDb = null;
    }
  }
}

