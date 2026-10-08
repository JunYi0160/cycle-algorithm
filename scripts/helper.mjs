import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { computeTechValuation, INPUT_FIELDS } from '../src/valuation.js';
import { isAutostartEnabled, enableAutostart, disableAutostart } from './daemon-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const CACHE_DIR = resolve(__dirname, '.cache');
mkdirSync(CACHE_DIR, { recursive: true });

const QUOTE_CACHE_FILE = join(CACHE_DIR, 'quotes.json');
const FX_CACHE_FILE = join(CACHE_DIR, 'fx.json');
const TOKEN_FILE = join(CACHE_DIR, 'helper-token.txt');

// Load or generate pairing token
let helperToken = '';
if (existsSync(TOKEN_FILE)) {
  helperToken = readFileSync(TOKEN_FILE, 'utf8').trim();
}
if (!helperToken) {
  helperToken = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, helperToken, 'utf8');
}

export function getHelperToken() {
  return helperToken;
}

// In-memory caches
let quoteCache = {};
if (existsSync(QUOTE_CACHE_FILE)) {
  try { quoteCache = JSON.parse(readFileSync(QUOTE_CACHE_FILE, 'utf8')); } catch {}
}
let fxCache = {};
if (existsSync(FX_CACHE_FILE)) {
  try { fxCache = JSON.parse(readFileSync(FX_CACHE_FILE, 'utf8')); } catch {}
}

function saveQuoteCache() {
  try { writeFileSync(QUOTE_CACHE_FILE, JSON.stringify(quoteCache, null, 2), 'utf8'); } catch {}
}
function saveFxCache() {
  try { writeFileSync(FX_CACHE_FILE, JSON.stringify(fxCache, null, 2), 'utf8'); } catch {}
}

const userHome = process.env.USERPROFILE || process.env.HOME || '.';
export const SETTINGS_FILE = process.env.AGY_SETTINGS_FILE || join(userHome, '.gemini', 'antigravity-cli', 'settings.json');

export function checkAgyConfig() {
  let useG1Credits = false;
  let permissionsOk = false;
  let rawSettings = null;
  let providerOk = true;

  if (!existsSync(SETTINGS_FILE)) {
    // If settings file does not exist, initialize it safely
    try {
      enforceCostProtection();
    } catch {}
  }

  if (!existsSync(SETTINGS_FILE)) {
    return {
      settingsFile: SETTINGS_FILE,
      useG1Credits: false,
      costProtectionActive: true,
      permissionsOk: false,
      rawSettings: null,
      error: '配置文件不存在'
    };
  }

  try {
    const text = readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '');
    rawSettings = JSON.parse(text);
  } catch (err) {
    return {
      settingsFile: SETTINGS_FILE,
      useG1Credits: false,
      costProtectionActive: false,
      permissionsOk: false,
      rawSettings: null,
      error: `配置文件解析失败: ${err.message}`
    };
  }

  useG1Credits = rawSettings.useG1Credits === true;
  const allows = rawSettings.permissions?.allow || [];
  permissionsOk = allows.some(r => String(r).includes('read_url'));

  if (rawSettings.modelProvider && String(rawSettings.modelProvider).toLowerCase() !== 'antigravity') {
    providerOk = false;
  }
  if (rawSettings.apiKey || rawSettings.geminiApiKey || rawSettings.billingEndpoint) {
    providerOk = false;
  }

  return {
    settingsFile: SETTINGS_FILE,
    useG1Credits,
    costProtectionActive: !useG1Credits && providerOk,
    permissionsOk,
    rawSettings
  };
}

export function enforceCostProtection() {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    } catch {}
  }
  settings.useG1Credits = false;
  delete settings.apiKey;
  delete settings.geminiApiKey;
  delete settings.billingEndpoint;
  if (settings.modelProvider && String(settings.modelProvider).toLowerCase() !== 'antigravity') {
    delete settings.modelProvider;
  }
  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  if (!settings.permissions.allow.includes('read_url(*)')) {
    settings.permissions.allow.push('read_url(*)');
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

let activeAgyProcess = null;

export async function runAgyPrompt(prompt, { timeoutMs = 120000 } = {}) {
  enforceCostProtection();
  return new Promise((resolve, reject) => {
    const agyBin = process.platform === 'win32' ? 'agy.exe' : 'agy';
    const args = ['-p', prompt, '--output-format', 'json'];
    
    let stdout = '';
    let stderr = '';
    const child = spawn(agyBin, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    });

    activeAgyProcess = child;
    let timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Antigravity 任务超时（${timeoutMs / 1000}秒）`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      clearTimeout(timer);
      activeAgyProcess = null;
      if (code !== 0) {
        return reject(new Error(`agy 进程退出（代码 ${code}）：${stderr || stdout || '无输出'}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        resolve({ rawOutput: stdout, error: err.message });
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      activeAgyProcess = null;
      reject(err);
    });
  });
}

export function parseJsonFromAgyResponse(resp) {
  if (!resp) return null;
  const text = (typeof resp === 'string' ? resp : resp.response || resp.rawOutput || '').trim();
  if (!text) return null;

  // 1. Try direct parsing first
  try {
    return JSON.parse(text);
  } catch {}

  // 2. Try markdown code block ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // 3. Try finding outermost JSON array: [...]
  const arrayMatch = text.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[1].trim());
    } catch {}
  }

  // 4. Try finding outermost JSON object: {...}
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[1].trim());
    } catch {}
  }

  return null;
}

export async function fetchLiveQuote(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('缺少 symbol');

  // Check cache (valid for today)
  const todayStr = new Date().toISOString().slice(0, 10);
  if (quoteCache[sym] && quoteCache[sym].as_of && quoteCache[sym].price > 0) {
    if (quoteCache[sym].as_of === todayStr || Date.now() - new Date(quoteCache[sym].retrieved_at).getTime() < 12 * 3600 * 1000) {
      return quoteCache[sym];
    }
  }

  const prompt = `Find the most recent market closing price and trading currency for stock ticker "${sym}". Output ONLY a valid JSON object matching this exact format:
{"symbol": "${sym}", "price": 123.45, "currency": "USD", "as_of": "YYYY-MM-DD", "source_url": "https://...", "source_name": "NASDAQ/NYSE/Yahoo/..."}`;

  const res = await runAgyPrompt(prompt, { timeoutMs: 90000 });
  const data = parseJsonFromAgyResponse(res);
  if (!data || !Number.isFinite(Number(data.price)) || Number(data.price) <= 0) {
    throw new Error(`未能获取 ${sym} 的有效报价：${JSON.stringify(data || res.response || '无数据')}`);
  }

  const quote = {
    symbol: sym,
    price: Number(data.price),
    currency: String(data.currency || 'USD').toUpperCase(),
    as_of: String(data.as_of || todayStr),
    source_url: String(data.source_url || ''),
    source_name: String(data.source_name || '公开行情'),
    retrieved_at: new Date().toISOString()
  };
  quoteCache[sym] = quote;
  saveQuoteCache();
  return quote;
}

export async function fetchLiveFxRate(from, to) {
  const f = String(from || '').trim().toUpperCase();
  const t = String(to || '').trim().toUpperCase();
  if (f === t) return { pair: `${f}/${t}`, rate: 1.0, as_of: new Date().toISOString().slice(0, 10) };

  const pair = `${f}/${t}`;
  if (fxCache[pair] && Date.now() - new Date(fxCache[pair].retrieved_at).getTime() < 24 * 3600 * 1000) {
    return fxCache[pair];
  }

  const prompt = `Find the latest exchange rate from currency ${f} to currency ${t} (${pair}). Output ONLY a valid JSON object matching this exact format:
{"pair": "${pair}", "rate": 1.08, "as_of": "YYYY-MM-DD", "source_url": "https://..."}`;

  const res = await runAgyPrompt(prompt, { timeoutMs: 60000 });
  const data = parseJsonFromAgyResponse(res);
  if (!data || !Number.isFinite(Number(data.rate)) || Number(data.rate) <= 0) {
    throw new Error(`未能获取 ${pair} 汇率：${JSON.stringify(data || res.response || '无数据')}`);
  }

  const fx = {
    pair,
    rate: Number(data.rate),
    as_of: String(data.as_of || new Date().toISOString().slice(0, 10)),
    source_url: String(data.source_url || ''),
    retrieved_at: new Date().toISOString()
  };
  fxCache[pair] = fx;
  saveFxCache();
  return fx;
}

export async function enrichHistoricalValuations(symbol, missingMonths) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('缺少 symbol');
  if (!Array.isArray(missingMonths) || !missingMonths.length) {
    return { symbol: sym, status: 'completed', results: [], missing: [] };
  }

  const prompt = `Search for publicly disclosed financial report figures and consensus analyst estimates for "${sym}" for the following month-end dates: ${missingMonths.join(', ')}.
For each date, look for:
- price: closing stock price on that month-end date
- eps_ttm: trailing 12-month EPS known at that date
- eps_ntm: consensus next 12-month EPS expected at that date
- eps_ntm_90d: consensus next 12-month EPS expected approximately 90 days before that date
- revenue_ttm: trailing 12-month revenue known at that date
- revenue_ntm: consensus next 12-month revenue expected at that date
- g_revenue_2: expected revenue growth rate for the following stage (decimal, e.g. 0.15)
- g_eps_2: expected EPS growth rate for the following stage (decimal, e.g. 0.20)
- fcf_ttm: trailing 12-month free cash flow
- sbc_ttm: trailing 12-month stock-based compensation
- ni_ttm: trailing 12-month net income

IMPORTANT:
1. Growth rates must be decimals (e.g. 0.25 for 25%).
2. Only provide numbers that have verifiable public source evidence (10-K, 10-Q, earnings release, analyst archive).
3. If data for a month or field cannot be found publicly, do NOT invent or guess; set that field to null.

Output ONLY a JSON array of objects:
[
  {
    "valuation_date": "YYYY-MM-DD",
    "inputs": {
      "price": number,
      "eps_ttm": number,
      "eps_ntm": number,
      "eps_ntm_90d": number,
      "revenue_ttm": number,
      "revenue_ntm": number,
      "g_revenue_2": number,
      "g_eps_2": number,
      "fcf_ttm": number,
      "sbc_ttm": number,
      "ni_ttm": number
    },
    "source_url": "https://...",
    "source_institution": "SEC EDGAR / Company IR / Archive",
    "evidence_summary": "Brief summary of where figures were found"
  }
]`;

  const res = await runAgyPrompt(prompt, { timeoutMs: 180000 });
  const list = parseJsonFromAgyResponse(res);

  const results = [];
  const foundMonths = new Set();

  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || !item.valuation_date || !item.inputs) continue;
      const date = String(item.valuation_date).slice(0, 10);
      const m = date.slice(0, 7);
      // Strict: Only accept months that were explicitly requested
      if (!missingMonths.includes(m)) continue;

      // Strict: Must have verifiable source evidence
      const sourceUrl = item.source_url ? String(item.source_url).trim() : null;
      const sourceInst = item.source_institution ? String(item.source_institution).trim() : null;
      const evidence = item.evidence_summary ? String(item.evidence_summary).trim() : null;
      if (!sourceUrl && !sourceInst && !evidence) {
        continue;
      }

      const inp = item.inputs;
      // Validate inputs
      const hasAllFields = INPUT_FIELDS.every(k => Number.isFinite(Number(inp[k])));
      if (!hasAllFields) continue;

      try {
        const derived = computeTechValuation(inp);
        if (derived.status === 'valid') {
          results.push({
            symbol: sym,
            valuation_date: date,
            s_tech: derived.s_tech,
            status: 'valid',
            source_code: 'agy-auto-enrichment',
            notes: `自动补数：${evidence || sourceInst || sourceUrl}`,
            interpolated: false,
            provenance: 'observation',
            raw_inputs: inp,
            derived_result: derived,
            source_institution: sourceInst,
            evidence_summary: evidence,
            source_url: sourceUrl,
            retrieved_at: new Date().toISOString()
          });
          foundMonths.add(m);
        }
      } catch {}
    }
  }

  const unfulfilled = missingMonths.filter(m => !foundMonths.has(m));
  const status = unfulfilled.length === 0 ? 'completed'
    : foundMonths.size > 0 ? 'partial'
    : 'insufficient_data';

  return {
    symbol: sym,
    status,
    results,
    missing: unfulfilled,
    message: status === 'completed'
      ? `已补全 ${results.length} 个月份的数据`
      : status === 'partial'
      ? `已补充 ${results.length} 个月份，尚有 ${unfulfilled.length} 个月份因公开免费来源不足未能补齐`
      : `公开网络未能免费检索到 ${sym} 在指定月份的历史一致预期与披露数据`
  };
}

// HTTP Server
export function startServer({ port = 8789 } = {}) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };

  const TRUSTED_ORIGINS = new Set([
    'http://127.0.0.1:8789',
    'http://localhost:8789',
    'http://127.0.0.1:8788',
    'http://localhost:8788',
    'http://127.0.0.1:8798',
    'http://localhost:8798',
    'http://127.0.0.1:8797',
    'http://localhost:8797',
    'https://junyi0160.github.io'
  ]);

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!TRUSTED_ORIGINS.has(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden: untrusted origin' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Helper-Token');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || '';
    const url = new URL(req.url, `http://${host || '127.0.0.1'}`);
    const pathname = url.pathname;

    const readBody = () => new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });

    const json = (data, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    try {
      // API Routes
      if (pathname === '/api/status') {
        const config = checkAgyConfig();
        json({
          ok: true,
          costProtection: config.costProtectionActive,
          useG1Credits: config.useG1Credits,
          permissionsOk: config.permissionsOk,
          autostart: isAutostartEnabled(),
          port,
          serverTime: new Date().toISOString()
        });
        return;
      }

      // Autostart toggle endpoint
      if (pathname === '/api/autostart') {
        if (req.method === 'GET') {
          json({ ok: true, enabled: isAutostartEnabled() });
          return;
        }
        if (req.method === 'POST') {
          if (!requireAuth()) return;
          const body = await readBody();
          const enabled = body.enabled ? enableAutostart() : disableAutostart();
          json({ ok: true, enabled: isAutostartEnabled() });
          return;
        }
      }

      // Session token endpoint for local loopback web app
      if (pathname === '/api/session-token' && req.method === 'GET') {
        const isLocalLoopback = !origin || origin.startsWith('http://127.0.0.1:') || origin.startsWith('http://localhost:');
        if (!isLocalLoopback) {
          json({ ok: false, error: 'Unauthorized: session token is only accessible from local loopback' }, 403);
          return;
        }
        json({ ok: true, token: helperToken });
        return;
      }

      // Token authentication check for mutating routes
      const tokenHeader = req.headers['x-helper-token'];
      const requireAuth = () => {
        if (!tokenHeader || tokenHeader !== helperToken) {
          json({ ok: false, error: 'Unauthorized: invalid or missing X-Helper-Token' }, 401);
          return false;
        }
        return true;
      };

      if (pathname === '/api/protect-cost' && req.method === 'POST') {
        if (!requireAuth()) return;
        enforceCostProtection();
        const config = checkAgyConfig();
        json({ ok: true, config });
        return;
      }

      if (pathname === '/api/quote' && req.method === 'POST') {
        if (!requireAuth()) return;
        const body = await readBody();
        const quote = await fetchLiveQuote(body.symbol);
        json({ ok: true, quote });
        return;
      }

      if (pathname === '/api/fx' && req.method === 'POST') {
        if (!requireAuth()) return;
        const body = await readBody();
        const fx = await fetchLiveFxRate(body.base, body.target);
        json({ ok: true, fx });
        return;
      }

      if (pathname === '/api/enrich' && req.method === 'POST') {
        if (!requireAuth()) return;
        const body = await readBody();
        const result = await enrichHistoricalValuations(body.symbol, body.missing_months);
        json({ ok: true, ...result });
        return;
      }

      if (pathname === '/api/cancel' && req.method === 'POST') {
        if (!requireAuth()) return;
        if (activeAgyProcess) {
          try { activeAgyProcess.kill(); } catch {}
          activeAgyProcess = null;
        }
        json({ ok: true, message: '已取消正在执行的任务' });
        return;
      }

      // Static file serving for standalone local web app
      const base = '/cycle-algorithm/';
      if (pathname === '/' || pathname === '/cycle-algorithm') {
        res.writeHead(302, { Location: base });
        res.end();
        return;
      }

      let sub = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.slice(1);
      if (!sub) sub = 'index.html';

      // Security: Disallow colon (Windows drive letters), null bytes, and path traversal
      if (sub.includes(':') || sub.includes('\0')) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      try {
        sub = decodeURIComponent(sub);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      // Strip leading slashes to prevent absolute path interpretation by resolve
      sub = sub.replace(/^[/\\]+/, '');
      const safePath = resolve(DIST, sub);
      const distPrefix = DIST.endsWith(sep) ? DIST : DIST + sep;

      if (!safePath.startsWith(distPrefix) && safePath !== resolve(DIST, 'index.html')) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      if (existsSync(safePath) && statSync(safePath).isFile()) {
        const ext = extname(safePath);
        res.writeHead(200, {
          'Content-Type': mime[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        res.end(readFileSync(safePath));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      json({ ok: false, error: err.message }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`Cycle Algorithm Local Helper running at http://127.0.0.1:${port}/cycle-algorithm/`);
      console.log(`API Status: http://127.0.0.1:${port}/api/status`);
      resolve({ server, port });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8789);
  startServer({ port }).then(() => {
    if (process.env.NO_OPEN !== '1') {
      const openCmd = process.platform === 'win32' ? 'start' : 'open';
      spawn(openCmd, [`http://127.0.0.1:${port}/cycle-algorithm/`], { shell: true, stdio: 'ignore' });
    }
  }).catch(e => {
    console.error('Failed to start helper:', e);
    process.exit(1);
  });
}
