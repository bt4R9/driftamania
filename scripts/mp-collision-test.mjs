// Two headless clients: start a race, ram A into B's remote car, and check
// whether car-to-car collision actually resolves (min separation stays sane).
import puppeteer from 'puppeteer-core';

const URL = process.env.MP_URL || 'http://localhost:4199/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
});

const mkPage = async (tag) => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[${tag}:PAGEERROR] ${e.message.slice(0, 200)}`));
  await page.goto(URL, { waitUntil: 'networkidle2' });
  if (await page.$('#btn-start-game')) await page.click('#btn-start-game');
  return page;
};

const a = await mkPage('A');
await a.type('#name-input', 'ALPHA');
await a.click('#btn-create');
await a.waitForFunction(() => document.querySelector('#lobby')?.style.display === 'flex', { timeout: 10000, polling: 500 });
const code = await a.evaluate(() => document.querySelector('#lobby-title').textContent.replace('ROOM', '').trim());

const b = await mkPage('B');
await b.type('#name-input', 'BRAVO');
await b.type('#room-input', code);
await b.click('#btn-join');
await b.waitForFunction(() => document.querySelector('#lobby')?.style.display === 'flex', { timeout: 10000, polling: 500 });

await a.waitForFunction(() => document.querySelectorAll('#lobby-players .player').length >= 2, { timeout: 45000, polling: 500 });
await b.waitForFunction(() => document.querySelectorAll('#lobby-players .player').length >= 2, { timeout: 45000, polling: 500 });
console.log('peers connected');

await a.click('#btn-ready');
await b.click('#btn-ready');
await a.waitForFunction(() => window.__game?.phase === 'racing', { timeout: 30000, polling: 500 });
await b.waitForFunction(() => window.__game?.phase === 'racing', { timeout: 30000, polling: 500 });
console.log('racing on both');

// wait until A has received at least one state packet from B
await a.waitForFunction(() => {
  const g = window.__game;
  return g.remotes && [...g.remotes.values()].some((rc) => rc.target);
}, { timeout: 20000, polling: 500 });

await a.bringToFront(); // occluded tabs get no rAF — A must be active to simulate
const result = await a.evaluate(async () => {
  const g = window.__game;
  const rc = [...g.remotes.values()].find((r) => r.target);
  const s = g.local.state;
  // park A 10 units short of B (along +x), aimed straight at it, at speed
  s.x = rc.render.x - 10; s.z = rc.render.z; s.y = rc.render.y ?? 0;
  s.vx = 30; s.vz = 0; s.heading = Math.atan2(1, 0);
  let minDist = 1e9, speedAtEnd = 0;
  const t0 = performance.now();
  await new Promise((done) => {
    const poll = () => {
      const d = Math.hypot(rc.render.x - s.x, rc.render.z - s.z);
      minDist = Math.min(minDist, d);
      speedAtEnd = Math.hypot(s.vx, s.vz);
      if (performance.now() - t0 > 2500) return done();
      setTimeout(poll, 16);
    };
    poll();
  });
  return { minDist: +minDist.toFixed(2), speedAtEnd: +speedAtEnd.toFixed(1), wallHit: s.wallHit };
});

console.log('min separation:', result.minDist, 'u | speed after ram:', result.speedAtEnd, 'u/s');
console.log(result.minDist < 2.5 ? 'FAIL: drove THROUGH the remote car' : 'PASS: collision resolved');
await browser.close();
