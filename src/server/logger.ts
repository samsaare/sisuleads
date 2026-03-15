import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function getLogDir(): string {
  // In packaged Electron: log to userData (writable, persists across updates)
  if (process.env.SISULEAD_USERDATA) {
    return process.env.SISULEAD_USERDATA;
  }
  // Development: log to project data/ directory
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '../../data');
}

const logDir = getLogDir();
const LOG_PATH = join(logDir, 'server.log');

try { mkdirSync(logDir, { recursive: true }); } catch {}

function write(level: string, ...args: any[]) {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `${ts} [${level}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_PATH, line); } catch {}
}

export const logger = {
  info:  (...a: any[]) => write('INFO ', ...a),
  warn:  (...a: any[]) => write('WARN ', ...a),
  error: (...a: any[]) => write('ERROR', ...a),
};

// Intercept unhandled errors to log file
process.on('uncaughtException',  (e) => { write('FATAL', e.stack || e.message); });
process.on('unhandledRejection', (e: any) => { write('FATAL', e?.stack || e); });
