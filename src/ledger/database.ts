/**
 * AgentTX SQLite Database Connection Manager
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { INITIAL_SCHEMA } from './schema.js';
import { logger } from '../utils/logger.js';

export class DatabaseManager {
  private db: DatabaseType;
  private dbPath: string;

  constructor(dbPath: string = '.agenttx/agenttx.db') {
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    try {
      this.db.exec(INITIAL_SCHEMA);
      logger.debug(`SQLite database initialized at ${this.dbPath}`);
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
