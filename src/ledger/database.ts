/**
 * AgentX SQLite Database Connection Manager
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { INITIAL_SCHEMA, migrateDatabase } from './schema.js';
import { logger } from '../utils/logger.js';

export class DatabaseManager {
  private db: DatabaseType;
  private dbPath: string;

  constructor(dbPath: string = process.env.AGENTX_DB_PATH || '.agentx/agentx.db') {
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true });
    }

    // Set busy timeout for cross-process concurrency safety
    this.db = new Database(dbPath, { timeout: 10000 });
    this.init();
  }

  private init(): void {
    try {
      this.db.pragma('busy_timeout = 10000');
      this.db.exec(INITIAL_SCHEMA);
      migrateDatabase(this.db);
      logger.debug(`SQLite database initialized and migrated at ${this.dbPath}`);
    } catch (err) {
      logger.error(`Failed to initialize SQLite database at ${this.dbPath}:`, err);
      throw err;
    }
  }

  public getDatabase(): DatabaseType {
    return this.db;
  }

  public close(): void {
    if (this.db.open) {
      this.db.close();
      logger.debug(`SQLite database connection closed: ${this.dbPath}`);
    }
  }
}
