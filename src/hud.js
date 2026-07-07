// DOM overlay updates: in-race HUD, lobby, results. No game logic here.

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
  $('hud-drift').style.opacity = d.drifting ? 1 : 0;

  // Score + drift chain / jump / lost feedback
  $('score-num').textContent = (d.score ?? 0).toLocaleString();
  const chain = $('hud-chain');
  if (d.wrecked) {
    chain.textContent = 'WRECKED — RESPAWNING…';
    chain.style.color = '#ff4d4d';
    chain.style.opacity = 1;
  } else if (d.tumbling) {
    chain.textContent = 'FLIPPING!';
    chain.style.color = '#ffb14d';
    chain.style.opacity = 1;
  } else if (d.lostFlash > 0) {
    chain.textContent = 'CRASH — DRIFT LOST';
    chain.style.color = '#ff4d4d';
    chain.style.opacity = Math.min(1, d.lostFlash);
  } else if (d.boostFlash > 0) {
    chain.textContent = 'BOOST';
    chain.style.color = '#22e6ff';
    chain.style.opacity = Math.min(1, d.boostFlash);
  } else if (d.jumpFlash > 0) {
    chain.textContent = `AIR +${d.jumpPts}`;
    chain.style.color = '#b6ff3d';
    chain.style.opacity = Math.min(1, d.jumpFlash);
  } else if (d.chain > 0) {
    chain.textContent = `+${d.chain}`;
    chain.style.color = '#ff2d9a';
    chain.style.opacity = 0.35 + 0.65 * d.chainT;
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
  } else if (d.wrongWay) {
    msg.textContent = 'WRONG WAY';
    msg.style.opacity = 1;
    msg.style.color = '#ff4d4d';
  } else {
    msg.style.opacity = 0;
  }

  // Standings board
  const html = d.standings.map((r, i) => `
    <div class="entry${r.isSelf ? ' self' : ''}">
      <span><span class="dot" style="background:${hex(r.color)}"></span>P${i + 1} ${esc(r.name)}</span>
      <span>${r.finished ? formatTime(r.time) : `L${r.lap}`}</span>
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
