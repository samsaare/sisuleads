import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../../../data/sisulead.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    // Run migrations on first connection
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    _db.exec(schema);

    // Runtime migrations: add columns that may be missing in existing DBs
    const campaignCols = (_db.prepare("PRAGMA table_info(campaigns)").all() as any[]).map(c => c.name);
    if (!campaignCols.includes('persona_config')) {
      _db.exec("ALTER TABLE campaigns ADD COLUMN persona_config TEXT DEFAULT NULL");
    }

    const leadCols = (_db.prepare("PRAGMA table_info(leads)").all() as any[]).map(c => c.name);
    if (!leadCols.includes('is_generic_contact')) {
      _db.exec("ALTER TABLE leads ADD COLUMN is_generic_contact INTEGER NOT NULL DEFAULT 0");
    }
  }
  return _db;
}
