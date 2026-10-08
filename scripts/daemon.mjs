import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const HELPER_SCRIPT = join(__dirname, 'helper.mjs');
const DIST_INDEX = join(ROOT, 'dist', 'index.html');
const PORT = Number(process.env.PORT || 8789);
const URL = `http://127.0.0.1:${PORT}/cycle-algorithm/`;

const isAutostart = process.argv.some(a => /autostart/i.test(a)) || process.env.NO_OPEN === '1';

function openBrowser() {
  if (isAutostart) return;
  const openCmd = process.platform === 'win32' ? 'start' : 'open';
  spawn(openCmd, [URL], { shell: true, stdio: 'ignore', windowsHide: true });
}

async function isServerRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
      signal: AbortSignal.timeout(600)
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const running = await isServerRunning();
  if (running) {
    openBrowser();
    process.exit(0);
  }

  // Ensure dist is built
  if (!existsSync(DIST_INDEX)) {
    const { execSync } = await import('node:child_process');
    try {
      execSync(`"${process.execPath}" scripts/build.mjs`, { cwd: ROOT, stdio: 'ignore' });
    } catch {}
  }

  // Spawn truly detached background daemon
  const child = spawn(process.execPath, [HELPER_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NO_OPEN: '1' // Let daemon.mjs control browser opening after port is ready
    }
  });

  child.unref();

  if (!isAutostart) {
    // Wait for server to become responsive, then open browser
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await isServerRunning()) {
        openBrowser();
        break;
      }
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
