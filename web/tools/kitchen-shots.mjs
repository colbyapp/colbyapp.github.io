// Screenshots of the real web app's kitchen mode in demo mode, for 1-8 probes and landscape / portrait screens.
// Needs Playwright (not a dependency): PLAYWRIGHT=/path/to/node_modules/playwright-core node tools/kitchen-shots.mjs [out]
// Uses the installed Google Chrome. Default output: ../docs/screenshots/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(WEB, '../docs/screenshots'));
const PW = process.env.PLAYWRIGHT ?? 'playwright-core';
const { chromium } = await import(PW.startsWith('/') ? pathToFileURL(path.join(PW, 'index.mjs')).href : PW);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, r) => {
  const f = path.join(WEB, decodeURIComponent(q.url.split(/[?#]/)[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const SHOTS = [
  ...[1, 2, 3, 4, 6, 8].map((n) => ({ name: `kitchen-web-${n}`, n, w: 1440, h: 900 })),
  ...[1, 3, 4].map((n) => ({ name: `kitchen-web-${n}-portrait`, n, w: 820, h: 1180 })),
];

fs.mkdirSync(OUT, { recursive: true });
// Keep earlier shots: move them to archive/<timestamp>/ instead of overwriting them.
const previous = fs.readdirSync(OUT).filter((f) => /^kitchen-web-.*\.png$/.test(f));
if (previous.length) {
  const archive = path.join(OUT, 'archive', new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-'));
  fs.mkdirSync(archive, { recursive: true });
  for (const f of previous) fs.renameSync(path.join(OUT, f), path.join(archive, f));
}
const browser = await chromium.launch({ channel: 'chrome' });
for (const s of SHOTS) {
  const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('colby.onboarded', 'true'); } catch {} });
  await page.goto(`${base}#demo=${s.n}`);
  await page.waitForFunction((n) => document.querySelectorAll('.chip, [data-select]').length >= n, s.n, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector('dialog[open]')?.close(); document.querySelector('.toast')?.remove(); });
  await page.click('#kitchen-button');
  await page.waitForFunction((n) => document.querySelectorAll('#kitchen .tile').length >= n, s.n, { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
  console.log(s.name, errors.join(' | ') || 'ok');
  await page.close();
}
await browser.close();
server.close();
