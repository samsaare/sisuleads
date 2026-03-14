#!/usr/bin/env node
// Kills any process on port 3001 then starts the Express server
import { execSync, spawn } from 'child_process';

try {
  execSync(
    'cmd /c "for /f "tokens=5" %a in (\'netstat -aon ^| findstr LISTENING ^| findstr :3001\') do taskkill /F /PID %a"',
    { stdio: 'ignore' }
  );
  console.log('[start-server] Cleared port 3001');
} catch {
  // Port was already free
}

// Small delay to let OS release the port
await new Promise(r => setTimeout(r, 500));

const child = spawn('npx', ['tsx', 'watch', 'src/server/index.ts'], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
