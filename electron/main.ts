import { app, BrowserWindow, shell } from 'electron';
import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !app.isPackaged;
let serverProcess: ChildProcess | null = null;

async function startServer(): Promise<void> {
  const userData = app.getPath('userData');
  await mkdir(userData, { recursive: true });

  // In dev: dist-server/ is in project root (two levels up from dist-electron/)
  // In prod: dist-server/ is in resources/
  const serverPath = isDev
    ? join(__dirname, '..', 'dist-server', 'index.js')
    : join(process.resourcesPath, 'dist-server', 'index.js');

  // Resources path: where .env.local lives
  const resourcesPath = isDev
    ? join(__dirname, '..')                // project root in dev
    : process.resourcesPath;

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3001',
      SISULEAD_USERDATA: userData,
      SISULEAD_RESOURCES: resourcesPath,
    },
    // Force ESM module loading (needed when "type": "module" in package.json)
    execArgv: [],
    stdio: 'pipe',
  });

  serverProcess.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  serverProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  serverProcess.on('error', (err) => console.error('[server]', err));
}

function waitForServer(url: string, maxMs = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      fetch(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - start > maxMs) {
            reject(new Error('Server did not start in time'));
          } else {
            setTimeout(check, 300);
          }
        });
    };
    check();
  });
}

async function createWindow(): Promise<void> {
  await startServer();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'SisuLead Miner',
    backgroundColor: '#E4E3E0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in default browser, not in Electron window
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    await waitForServer('http://localhost:3001/api/campaigns');
  } catch {
    console.error('Server failed to start — loading anyway');
  }

  win.loadURL('http://localhost:3001');

  // Open DevTools only in dev
  if (isDev) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  serverProcess?.kill('SIGTERM');
  app.quit();
});

app.on('before-quit', () => {
  serverProcess?.kill('SIGTERM');
});
