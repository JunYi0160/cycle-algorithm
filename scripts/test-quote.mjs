import { spawn } from 'node:child_process';

const prompt = 'Find the current or most recent market closing price of NVDA in USD. Output ONLY JSON: {"symbol": "NVDA", "price": 120.5, "as_of": "2026-10-08", "source_url": "https://finance.yahoo.com"}';
console.log('Starting agy.exe with prompt...');
const start = Date.now();
const child = spawn('agy.exe', ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json']);

let out = '';
let err = '';
child.stdout.on('data', d => {
  out += d;
  process.stdout.write(d.toString());
});
child.stderr.on('data', d => {
  err += d;
  process.stderr.write(d.toString());
});
child.on('close', c => {
  console.log(`\nFinished in ${(Date.now() - start) / 1000}s, exit code: ${c}`);
});
