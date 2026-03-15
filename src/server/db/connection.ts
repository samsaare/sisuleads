import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

// esbuild inlines .sql files as string constants when loader: { '.sql': 'text' } is set.
// In development (tsx), the import is resolved normally via the file system.
import SCHEMA_SQL from './schema.sql';

let _db: Database.Database | null = null;

function getDbPath(): string {
  // In packaged Electron: SISULEAD_USERDATA is set by the main process
  if (process.env.SISULEAD_USERDATA) {
    return join(process.env.SISULEAD_USERDATA, 'sisulead.db');
  }
  // Development: use project-local data/ directory
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '../../../data/sisulead.db');
}

export function getDb(): Database.Database {
  if (!_db) {
    const dbPath = getDbPath();

    // Ensure the directory exists (important for first run in userData)
    const dbDir = dirname(dbPath);
    mkdirSync(dbDir, { recursive: true });

    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    // Run schema (inlined by esbuild, or imported as text in dev)
    _db.exec(SCHEMA_SQL);

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
