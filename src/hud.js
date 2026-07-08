// DOM overlay updates: in-race HUD, lobby, results. No game logic here.

import { buildTrackGeometry } from './trackgeom.js';

const $ = (id) => document.getElementById(id);

export function formatTime(t) {
  if (t == null || !isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function setHudVisible(on) {
  $('hud').style.display = on ? 'block' : 'none';
}

export function setRoomLabel(text) {
  const el = $('hud-room');
  el.innerHTML = text;
  el.style.display = text ? 'block' : 'none';
}

let lastBoardHtml = '';

export function updateHud(d) {
  $('speed-num').textContent = Math.round(d.speed * 3.4); // display km/h
  $('lap-num').textContent = `${d.lap}/${d.laps}`;
  $('pos-num').textContent = d.position > 0 ? `P${d.position}` : '';
  $('lap-time').textContent = formatTime(d.lapTime);
  $('lap-best').textContent = `best ${formatTime(d.bestLap)}`;
  const driftEl = $('hud-drift');
  driftEl.style.opacity = d.drifting ? 1 : 0;
  driftEl.textContent = (d.mult ?? 1) > 1 ? `DRIFT ×${d.mult}` : 'DRIFT';

  // Score feedback — numbers and colors only:
  //   orange = pending drift points, green = banked, red = lost.
  $('score-num').textContent = (d.score ?? 0).toLocaleString();
  const chain = $('hud-chain');
  if (d.lostFlash > 0) {
    chain.textContent = `+${d.lostPts}`;
    chain.style.color = '#ff4d4d';
    chain.style.opacity = Math.min(1, d.lostFlash);
  } else if (d.chain > 0) {
    chain.textContent = `+${d.chain}`;
    chain.style.color = '#ffb14d';
    chain.style.opacity = 0.45 + 0.55 * d.chainT;
  } else if (d.bankFlash > 0) {
    chain.textContent = `+${d.bankPts}`;
    chain.style.color = '#b6ff3d';
    chain.style.opacity = Math.min(1, d.bankFlash);
  } else if (d.boostFlash > 0) {
    chain.textContent = 'BOOST';
    chain.style.color = '#22e6ff';
    chain.style.opacity = Math.min(1, d.boostFlash);
  } else if (d.jumpFlash > 0) {
    chain.textContent = `+${d.jumpPts}`;
    chain.style.color = '#b6ff3d';
    chain.style.opacity = Math.min(1, d.jumpFlash);
  } else {
    chain.style.opacity = 0;
  }

  // Center message: countdown, GO, wrong way, finished
  const msg = $('hud-msg');
  if (d.phase === 'countdown') {
    msg.textContent = String(Math.max(1, Math.ceil(d.countdown)));
    msg.style.opacity = 1;
    msg.style.color = '#22e6ff';
  } else if (d.phase === 'racing' && d.lapTime < 1 && d.lap === 1 && !d.finished) {
    msg.textContent = 'GO!';
    msg.style.opacity = 1;
    msg.style.color = '#b6ff3d';
  } else if (d.finished) {
    msg.textContent = `FINISHED — P${d.position}`;
    msg.style.opacity = 1;
    msg.style.color = '#22e6ff';
  } else if (d.finishWindow != null && d.phase === 'racing') {
    // Chase window: someone already won — finish before this hits zero or
    // the finish bonus is gone. Amber, going red as it runs out.
    msg.textContent = Math.ceil(d.finishWindow);
    msg.style.opacity = d.finishWindow > 0 ? 1 : 0;
    msg.style.color = d.finishWindow > 10 ? '#ffb14d' : '#ff4d4d';
  } else if (d.wrongWay) {
    msg.textContent = 'WRONG WAY';
    msg.style.opacity = 1;
    msg.style.color = '#ff4d4d';
  } else {
    msg.style.opacity = 0;
  }

  // Cinema mode: fade the results card so the flyover shots show through.
  $('results').classList.toggle('cinema', !!d.cinema);

  // Standings board — ranked and displayed by SCORE; lap is secondary.
  const html = d.standings.map((r, i) => `
    <div class="entry${r.isSelf ? ' self' : ''}">
      <span><span class="dot" style="background:${hex(r.color)}"></span>P${i + 1} ${esc(r.name)}</span>
      <span>${(r.score ?? 0).toLocaleString()} <span style="color:var(--muted);font-size:10px">${r.finished ? '✓' : `L${r.lap}`}</span></span>
    </div>`).join('');
  if (html !== lastBoardHtml) {
    lastBoardHtml = html;
    $('board-list').innerHTML = html;
  }
}

// ---- Lobby ----
export function showLobby({ title, players, isHost, trackId, statusText, solo, myReady }) {
  $('lobby').style.display = 'flex';
  $('lobby-title').textContent = title;
  $('lobby-players').innerHTML = players.map((p) => `
    <div class="player">
      <span class="dot" style="background:${hex(p.color)}"></span>
      ${esc(p.name)}${p.tag ? ` <span class="tag">${p.tag}</span>` : ''}
      ${p.ready ? ' <span style="color:var(--lime);font-size:11px;letter-spacing:1px">✓ READY</span>' : ''}
    </div>`).join('');
  for (const btn of document.querySelectorAll('#lobby-tracks button')) {
    btn.classList.toggle('selected', btn.dataset.track === trackId);
    btn.disabled = !isHost;
  }
  // Solo: classic start button. Multiplayer: everyone readies up instead —
  // the race launches itself when the whole lobby is ready.
  $('btn-start-race').style.display = solo ? 'block' : 'none';
  const rb = $('btn-ready');
  rb.style.display = solo ? 'none' : 'block';
  rb.textContent = myReady ? '✗ NOT READY' : '✓ READY';
  rb.classList.toggle('magenta', !myReady);
  rb.classList.toggle('cyan', myReady);
  $('lobby-status').textContent = statusText ?? '';
}

export function hideLobby() { $('lobby').style.display = 'none'; }

// Static top-down preview of a track def, drawn into a lobby button canvas.
// Same look as the HUD minimap: road band, amber ramps, start tick.
export function renderTrackPreview(def, cv) {
  const g = buildTrackGeometry(def, 7);
  const ctx = cv.getContext('2d');
  const S = g.sampleCount;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of g.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const pad = 6 + g.maxWidth / 2 * (cv.width / Math.max(maxX - minX, maxZ - minZ));
  const s = Math.min(
    (cv.width - 2 * pad) / Math.max(1, maxX - minX),
    (cv.height - 2 * pad) / Math.max(1, maxZ - minZ),
  );
  const pt = (x, z) => [cv.width / 2 + (x - (minX + maxX) / 2) * s, cv.height / 2 + (z - (minZ + maxZ) / 2) * s];
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.beginPath();
  for (let i = 0; i <= S; i += 4) {
    const j = i % S;
    const e = g.sideOffset(j, g.clampLat(j, g.halfWidthAt(j)));
    const [mx, my] = pt(e.x, e.z);
    i === 0 ? ctx.moveTo(mx, my) : ctx.lineTo(mx, my);
  }
  for (let i = S; i >= 0; i -= 4) {
    const j = i % S;
    const e = g.sideOffset(j, g.clampLat(j, -g.halfWidthAt(j)));
    const [mx, my] = pt(e.x, e.z);
    ctx.lineTo(mx, my);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(96,106,138,0.6)';
  ctx.fill();
  for (const r of g.ramps) {
    const px = -r.fz, pz = r.fx, hw = r.w / 2;
    ctx.beginPath();
    [[r.footX + px * hw, r.footZ + pz * hw], [r.footX - px * hw, r.footZ - pz * hw],
     [r.lipX - px * hw, r.lipZ - pz * hw], [r.lipX + px * hw, r.lipZ + pz * hw]].forEach(([wx, wz], i) => {
      const [mx, my] = pt(wx, wz);
      i === 0 ? ctx.moveTo(mx, my) : ctx.lineTo(mx, my);
    });
    ctx.closePath();
    ctx.fillStyle = '#ffb14d';
    ctx.fill();
  }
  const n = g.normalAt(0);
  const p0 = g.points[0];
  const hw0 = g.halfWidthAt(0);
  const [ax, ay] = pt(p0.x + n.nx * hw0, p0.z + n.nz * hw0);
  const [bx, by] = pt(p0.x - n.nx * hw0, p0.z - n.nz * hw0);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  ctx.lineWidth = 2; ctx.strokeStyle = '#e8e8e8'; ctx.stroke();
}

// ---- Results ----
export function showResults(rows, { isHost, solo }) {
  $('results').style.display = 'flex';
  $('results-list').innerHTML = rows.map((r, i) => `
    <div class="entry${r.isSelf ? ' self' : ''}">
      <span>P${i + 1} <span class="dot" style="background:${hex(r.color)}"></span>${esc(r.name)}</span>
      <span style="color:var(--lime);font-weight:700">${r.score != null ? r.score.toLocaleString() + ' pts' : ''}</span>
      <span class="best">${r.time != null ? formatTime(r.time) : 'racing…'}${r.bestLap != null ? ' · best ' + formatTime(r.bestLap) : ''}</span>
    </div>`).join('');
  $('btn-rematch').style.display = (isHost || solo) ? 'block' : 'none';
  $('results-status').textContent = (isHost || solo) ? '' : 'waiting for host to restart…';
}

export function hideResults() { $('results').style.display = 'none'; }

export function showMenu() { $('menu').style.display = 'flex'; }
export function hideMenu() { $('menu').style.display = 'none'; }

function hex(c) { return `#${c.toString(16).padStart(6, '0')}`; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
