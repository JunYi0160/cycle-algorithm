import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const VBS_PATH = join(__dirname, 'start-daemon.vbs');
const ICO_PATH = join(ROOT, 'public', 'icon.ico');
const WSCRIPT_PATH = 'C:\\Windows\\System32\\wscript.exe';

export function getStartupDir() {
  if (process.platform !== 'win32') return join(process.env.HOME || '.', '.config', 'autostart');
  const appdata = process.env.APPDATA || join(process.env.USERPROFILE || 'C:\\Users\\jun', 'AppData', 'Roaming');
  return join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function getStartupShortcutPath() {
  return join(getStartupDir(), 'Cycle Algorithm 守护进程.lnk');
}

export function getDesktopDirs() {
  if (process.platform !== 'win32') return [];
  const dirs = [];
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\jun';
  const oneDrive = join(userProfile, 'OneDrive', 'Desktop');
  const standard = join(userProfile, 'Desktop');
  if (existsSync(oneDrive)) dirs.push(oneDrive);
  if (existsSync(standard) && standard !== oneDrive) dirs.push(standard);
  return dirs;
}

function writeWindowsShortcut(lnkPath, { target, args = '', workDir = ROOT, icon = ICO_PATH, desc = '' }) {
  const psScript = `
$sh = New-Object -ComObject WScript.Shell
$link = $sh.CreateShortcut('${lnkPath.replace(/\\/g, '\\\\')}')
$link.TargetPath = '${target.replace(/\\/g, '\\\\')}'
$link.Arguments = '${args.replace(/\\/g, '\\\\')}'
$link.WorkingDirectory = '${workDir.replace(/\\/g, '\\\\')}'
$link.Description = '${desc.replace(/'/g, "''")}'
$link.WindowStyle = 7
if (Test-Path '${icon.replace(/\\/g, '\\\\')}') {
  $link.IconLocation = '${icon.replace(/\\/g, '\\\\')},0'
}
$link.Save()
`.trim();

  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\r?\n/g, '; ')}"`, {
    stdio: 'ignore'
  });
}

export function createDesktopShortcut() {
  if (process.platform !== 'win32') return [];
  const dirs = getDesktopDirs();
  const created = [];
  for (const dir of dirs) {
    const lnk = join(dir, 'Cycle Algorithm 守护进程.lnk');
    writeWindowsShortcut(lnk, {
      target: WSCRIPT_PATH,
      args: `"${VBS_PATH}"`,
      desc: 'Cycle Algorithm 本地守护进程 (Antigravity Bridge)'
    });
    created.push(lnk);
  }
  return created;
}

export function isAutostartEnabled() {
  if (process.platform !== 'win32') return false;
  return existsSync(getStartupShortcutPath());
}

export function enableAutostart() {
  if (process.platform !== 'win32') return false;
  const startupLnk = getStartupShortcutPath();
  const dir = dirname(startupLnk);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeWindowsShortcut(startupLnk, {
    target: WSCRIPT_PATH,
    args: `"${VBS_PATH}" /autostart`,
    desc: 'Cycle Algorithm 守护进程开机静默启动'
  });
  return true;
}

export function disableAutostart() {
  if (process.platform !== 'win32') return false;
  const startupLnk = getStartupShortcutPath();
  if (existsSync(startupLnk)) {
    try { unlinkSync(startupLnk); } catch {}
  }
  return false;
}

// CLI usage
if (process.argv[1] === __filename) {
  const action = (process.argv[2] || 'status').toLowerCase();
  if (action === 'enable') {
    enableAutostart();
    createDesktopShortcut();
    console.log('✓ 已开启开机自启动，并更新了桌面快捷方式');
  } else if (action === 'disable') {
    disableAutostart();
    console.log('✓ 已关闭开机自启动（已移除自启项）');
  } else if (action === 'shortcut') {
    const created = createDesktopShortcut();
    console.log('✓ 已生成/更新桌面快捷方式:', created);
  } else {
    console.log('--- Cycle Algorithm 守护进程配置 ---');
    console.log('开机自启动状态:', isAutostartEnabled() ? '已开启' : '未开启');
    console.log('自启快捷方式位置:', getStartupShortcutPath());
    console.log('桌面路径:', getDesktopDirs());
  }
}
