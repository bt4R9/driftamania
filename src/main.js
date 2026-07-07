import { Game } from './game.js';
import { Net, selfId, makeRoomCode } from './net.js';
import { TRACKS } from './tracks.js';
import { CAR_COLORS, CAR_MODELS } from './carmesh.js';
import { AI_NAMES } from './ai.js';
import * as ui from './hud.js';

const $ = (id) => document.getElementById(id);

let net = null;
let solo = false;
let trackId = TRACKS[0].id;
let customDef = null; // imported track definition ('__custom' when active)
let results = []; // [{key, name, color, time, bestLap, isSelf}]
let racing = false;
let ready = false;

const game = new Game($('app'), {
  onHud: (d) => ui.updateHud(d),
  onLocalFinish: (entry) => {
    addResult({ ...entry, isSelf: true });
    net?.sendFin({ time: entry.time, bestLap: entry.bestLap, score: entry.score });
    ui.showResults(resultRows(), { isHost: isHost(), solo });
  },
  onEntryFinish: (entry) => {
    addResult(entry);
    refreshResultsIfOpen();
  },
});
game.loadTrack(trackId);

function isHost() { return solo || (net?.isHost ?? true); }

function myName() { return $('name-input').value.trim().toUpperCase() || 'PLAYER'; }

function colorFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAR_COLORS[h % CAR_COLORS.length];
}

// Body kit per driver — hashed from the peer id so every client agrees.
function modelFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 37 + ch.charCodeAt(0)) >>> 0;
  return CAR_MODELS[h % CAR_MODELS.length];
}

// ---------- Menu ----------
$('btn-solo').onclick = () => {
  solo = true;
  ui.setRoomLabel('');
  enterLobby();
};
$('btn-create').onclick = () => joinMultiplayer(makeRoomCode());
$('btn-join').onclick = () => {
  const code = $('room-input').value.trim().toUpperCase();
  if (code.length < 4) { $('room-input').focus(); return; }
  joinMultiplayer(code);
};

function joinMultiplayer(code) {
  solo = false;
  ready = false;
  net = new Net(code, { name: myName(), ready: false }, {
    onPeers: () => {
      if (!racing) enterLobby();
      maybeAutoStart();
    },
    onState: (id, state) => game.remoteState(id, state),
    onRace: (msg) => {
      if (msg.type === 'start') beginRace(msg.def ?? msg.track, msg.order, msg.seed);
      else if (msg.type === 'track') {
        if (msg.def) { customDef = msg.def; trackId = '__custom'; }
        else { customDef = null; trackId = msg.track; }
        if (!racing) enterLobby();
      }
      else if (msg.type === 'lobby') backToLobby();
    },
    onPickup: (d) => game.remotePickup(d.id),
    onFin: (fin, id) => {
      game.markRemoteFinished(id, fin);
      const profile = net.peers.get(id)?.profile;
      addResult({ key: id, name: profile?.name ?? 'DRIVER', color: colorFor(id), ...fin });
      refreshResultsIfOpen();
    },
  });
  game.net = net;
  ui.setRoomLabel(`ROOM <b>${code}</b> · click to copy`);
  $('hud-room').onclick = () => navigator.clipboard?.writeText(code);
  enterLobby();
}

// ---------- Lobby ----------
function lobbyPlayers() {
  if (solo) {
    return [
      { name: myName(), color: CAR_COLORS[0], tag: 'YOU' },
      ...AI_NAMES.slice(0, 3).map((n, i) => ({ name: n, color: CAR_COLORS[i + 1], tag: 'AI' })),
    ];
  }
  const players = [{ name: myName(), color: colorFor(selfId), tag: net.isHost ? 'YOU · HOST' : 'YOU', ready }];
  for (const [id, p] of net.peers) {
    players.push({
      name: p.profile?.name ?? '…', color: colorFor(id),
      tag: id === net.hostId ? 'HOST' : '', ready: !!p.profile?.ready,
    });
  }
  return players;
}

// The race starts itself when everyone in the lobby is ready (2+ players).
function maybeAutoStart() {
  if (solo || racing || !net || !net.isHost) return;
  if (net.peers.size < 1 || !ready) return;
  for (const [, p] of net.peers) if (!p.profile?.ready) return;
  const seed = Math.floor(Math.random() * 1e9);
  const order = [selfId, ...net.peers.keys()].sort();
  net.sendRace({ type: 'start', track: trackId, def: customDef ?? undefined, order, seed });
  beginRace(customDef ?? trackId, order, seed);
}

function enterLobby() {
  ui.hideMenu();
  ui.hideResults();
  ui.setHudVisible(false);
  game.loadTrack(customDef ?? trackId);
  ui.showLobby({
    title: solo ? 'SINGLE PLAYER' : `ROOM ${net.code}`,
    players: lobbyPlayers(),
    isHost: isHost(),
    trackId,
    statusText: (customDef ? `CUSTOM TRACK: ${customDef.name} · ` : '') + (solo ? '' : (net.peers.size === 0
      ? 'share the room code — race starts when everyone is ready'
      : (ready ? 'waiting for the others to ready up…' : 'hit READY when you are set'))),
    solo,
    myReady: ready,
  });
}

for (const t of TRACKS) {
  const btn = document.createElement('button');
  btn.dataset.track = t.id;
  btn.innerHTML = `${t.name}<span>${t.blurb}</span>`;
  btn.onclick = () => {
    if (!isHost()) return;
    trackId = t.id;
    customDef = null;
    net?.sendRace({ type: 'track', track: trackId });
    enterLobby();
  };
  $('lobby-tracks').appendChild(btn);
}

$('btn-start-race').onclick = () => {
  if (!solo) return; // multiplayer starts via ready-up
  const seed = Math.floor(Math.random() * 1e9);
  beginRace(customDef ?? trackId, null, seed);
};

$('btn-ready').onclick = () => {
  if (solo || !net) return;
  ready = !ready;
  net.updateProfile({ name: myName(), ready });
  enterLobby();
  maybeAutoStart();
};

// Import a track built in the editor (host only); definition syncs to peers.
$('btn-import-track').onclick = () => { if (isHost()) $('track-file').click(); };
$('track-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.points) || d.points.length < 4) throw new Error('needs points[]');
    customDef = { name: d.name ?? 'CUSTOM', blurb: d.blurb ?? '', points: d.points, ramps: d.ramps ?? [], decor: d.decor ?? [] };
    trackId = '__custom';
    net?.sendRace({ type: 'track', def: customDef });
    enterLobby();
  } catch (err) {
    alert('Track import failed: ' + err.message);
  }
  e.target.value = '';
};

$('btn-leave').onclick = () => {
  game.audio.playMusic('menu');
  net?.leave();
  net = null;
  game.net = null;
  racing = false;
  game.toIdle();
  ui.hideLobby();
  ui.setRoomLabel('');
  ui.showMenu();
};

// ---------- Race ----------
function beginRace(track, order, seed) {
  game.audio.playMusic('race');
  if (typeof track === 'object') { customDef = track; trackId = '__custom'; }
  else { trackId = track; }
  seed = seed ?? Math.floor(Math.random() * 1e9);
  results = [];
  racing = true;

  let grid;
  if (solo) {
    grid = [
      { key: 'self', name: myName(), color: CAR_COLORS[0], model: CAR_MODELS[0] },
      ...AI_NAMES.slice(0, 3).map((n, i) => ({
        key: `ai:${i}`, name: n, color: CAR_COLORS[i + 1], skill: 1.1 + i * 0.075,
        model: CAR_MODELS[(i + 1) % CAR_MODELS.length],
      })),
    ];
  } else {
    grid = order.map((id) => ({
      key: id === selfId ? 'self' : id,
      name: id === selfId ? myName() : (net.peers.get(id)?.profile?.name ?? 'DRIVER'),
      color: colorFor(id),
      model: modelFor(id),
    }));
  }

  ui.hideLobby();
  ui.hideResults();
  ui.setHudVisible(true);
  game.startRace(track, grid, seed);
}

function addResult(entry) {
  if (results.some((r) => r.key === entry.key)) return;
  results.push(entry);
  // Winner = highest TOTAL score (finish-position bonus + style points).
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.time - b.time);
}

function resultRows() {
  const rows = results.map((r) => ({ ...r, isSelf: r.key === 'self' || r.isSelf }));
  // Show still-racing participants below the finishers.
  for (const s of game.standings()) {
    if (!rows.some((r) => r.key === s.key)) {
      rows.push({ key: s.key, name: s.name, color: s.color, time: null, bestLap: null, isSelf: s.isSelf });
    }
  }
  return rows;
}

function refreshResultsIfOpen() {
  if ($('results').style.display === 'flex') {
    ui.showResults(resultRows(), { isHost: isHost(), solo });
  }
}

function backToLobby() {
  game.audio.playMusic('menu');
  racing = false;
  ready = false;
  net?.updateProfile({ name: myName(), ready: false });
  game.toIdle();
  ui.setHudVisible(false);
  ui.hideResults();
  enterLobby();
}

$('btn-rematch').onclick = () => {
  if (solo) { beginRace(customDef ?? trackId, null, null); return; }
  net.sendRace({ type: 'lobby' });
  backToLobby();
};

$('btn-results-menu').onclick = () => {
  if (solo) {
    racing = false;
    game.toIdle();
    game.audio.playMusic('menu');
    ui.hideResults();
    ui.setHudVisible(false);
    ui.showMenu();
  } else {
    backToLobby();
  }
};

// Splash gate: the first REAL click lands here, which activates the
// AudioContext cleanly — then the actual menu (or a pending test drive) shows.
$('btn-start-game').onclick = () => {
  $('splash').style.display = 'none';

  // Test-drive entry from the editor: load the draft and race it solo, now.
  if (new URLSearchParams(location.search).has('testdrive')) {
    try {
      const d = JSON.parse(localStorage.getItem('dc-editor-draft'));
      if (d?.points?.length >= 4) {
        solo = true;
        ui.hideMenu();
        ui.setRoomLabel('TEST DRIVE · <b>BACK TO EDITOR</b>');
        $('hud-room').onclick = () => { location.href = './editor.html'; };
        beginRace(
          { name: d.name ?? 'TEST TRACK', blurb: '', points: d.points, ramps: d.ramps ?? [], decor: d.decor ?? [] },
          null, null,
        );
        return;
      }
    } catch { /* fall through to the normal menu */ }
  }
  ui.showMenu();
};

game.audio.playMusic('menu'); // queued; starts the moment the splash is clicked

// Prefill a room code from the URL hash (share links like game.html#TRBO)
const hashCode = location.hash.slice(1).toUpperCase();
if (/^[A-Z2-9]{4,5}$/.test(hashCode)) $('room-input').value = hashCode;
