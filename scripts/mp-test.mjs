// End-to-end multiplayer test: two headless Chrome pages, A creates a room,
// B joins by code; assert both lobbies show 2 players.
import puppeteer from 'puppeteer-core';

const URL = process.env.MP_URL || 'http://localhost:4199/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

const mkPage = async (tag) => {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') console.log(`[${tag}:${t}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`[${tag}:PAGEERROR] ${e.message.slice(0, 300)}`));
  await page.goto(URL, { waitUntil: 'networkidle2' });
  if (await page.$('#btn-start-game')) await page.click('#btn-start-game');
  return page;
};

const a = await mkPage('A');
await a.type('#name-input', 'ALPHA');
await a.click('#btn-create');
await a.waitForFunction(() => document.querySelector('#lobby')?.style.display === 'flex', { timeout: 10000 });
const code = await a.evaluate(() => document.querySelector('#lobby-title').textContent.replace('ROOM', '').trim());
console.log('room code:', code);

const b = await mkPage('B');
await b.type('#name-input', 'BRAVO');
await b.type('#room-input', code);
await b.click('#btn-join');
await b.waitForFunction(() => document.querySelector('#lobby')?.style.display === 'flex', { timeout: 10000 });

// wait up to 45s for the two lobbies to see each other
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < 45000) {
  const [na, nb] = await Promise.all([
    a.evaluate(() => document.querySelectorAll('#lobby-players .player').length),
    b.evaluate(() => document.querySelectorAll('#lobby-players .player').length),
  ]);
  if (na >= 2 && nb >= 2) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(ok ? `PEERS CONNECTED in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'TIMEOUT: peers never saw each other');

if (ok) {
  // full flow: both ready up → race should start (HUD becomes visible)
  await a.click('#btn-ready');
  await b.click('#btn-ready');
  try {
    await Promise.all([
      a.waitForFunction(() => document.querySelector('#hud')?.style.display === 'block', { timeout: 20000 }),
      b.waitForFunction(() => document.querySelector('#hud')?.style.display === 'block', { timeout: 20000 }),
    ]);
    console.log('RACE STARTED on both clients');
  } catch {
    console.log('READY-UP FAILED: race did not start');
  }
}
await browser.close();
process.exit(ok ? 0 : 1);
