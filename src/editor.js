// Track editor: drag control points, tune per-point height/width, place free
// ramp objects — rendered with the REAL Track builder so WYSIWYG is exact.
import * as THREE from 'three';
import { Track } from './track.js';
import { buildTrackGeometry } from './trackgeom.js';
import { TRACKS } from './tracks.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'dc-editor-draft';

// ---------- state ----------
let def = loadDraft() ?? blankOval();
let selected = null;      // { type: 'point' | 'ramp', i }
let placingRamp = false;
let placingDecor = null; // decor type being placed
let track = null;

function blankOval() {
  const points = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    points.push([Math.round(Math.sin(a) * 420), Math.round(Math.cos(a) * 300), 0, 38]);
  }
  return { name: 'MY TRACK', blurb: 'custom', points, ramps: [] };
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    return d?.points?.length >= 4 ? d : null;
  } catch { return null; }
}

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(def));
}

// ---------- three scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.add(new THREE.AmbientLight(0x8899cc, 0.7));

let zoom = 0.55; // px per world unit-ish
let panX = 0, panZ = 0;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
camera.up.set(0, 0, -1);
function updateCamera() {
  const w = innerWidth / zoom / 2, h = innerHeight / zoom / 2;
  camera.left = -w; camera.right = w; camera.top = h; camera.bottom = -h;
  camera.position.set(panX, 800, panZ);
  camera.lookAt(panX, 0, panZ);
  camera.updateProjectionMatrix();
}
updateCamera();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateCamera();
});

// markers
const markerGroup = new THREE.Group();
scene.add(markerGroup);
let trackGroup = null;
let waveT = 0;

// ---------- rebuild ----------
let rebuildTimer = null;
function scheduleRebuild(immediate = false) {
  saveDraft();
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildTrack, immediate ? 0 : 140);
  refreshMarkers();
  refreshPanel();
}

function rebuildTrack() {
  if (trackGroup) {
    scene.remove(trackGroup);
    trackGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material?.dispose) o.material.dispose();
    });
  }
  try {
    track = new Track(def, 1);
    trackGroup = track.group;
    scene.add(trackGroup);
    validate();
  } catch (e) {
    $('validation').innerHTML = `<span class="bad">geometry error: ${e.message}</span>`;
  }
}

function refreshMarkers() {
  markerGroup.clear();
  def.points.forEach(([x, z, y = 0], i) => {
    const isSel = selected?.type === 'point' && selected.i === i;
    const color = i === 0 ? 0xb6ff3d : isSel ? 0xffffff : 0x22e6ff;
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(isSel ? 9 : 6.5, isSel ? 9 : 6.5, 3, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    m.position.set(x, Math.max(y, 0) + 3, z);
    m.userData = { type: 'point', i };
    markerGroup.add(m);
  });
  const DECOR_COLORS = { wall: 0xff5c5c, block: 0xa85cff, arch: 0x22e6ff, pylon: 0xe8eaf0 };
  (def.decor ?? []).forEach((d, i) => {
    const isSel = selected?.type === 'decor' && selected.i === i;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(isSel ? 13 : 9, 3, isSel ? 13 : 9),
      new THREE.MeshBasicMaterial({ color: isSel ? 0xffffff : DECOR_COLORS[d.type] ?? 0x888888 }),
    );
    m.position.set(d.at[0], 5, d.at[1]);
    m.userData = { type: 'decor', i };
    markerGroup.add(m);
  });
  (def.ramps ?? []).forEach((r, i) => {
    const isSel = selected?.type === 'ramp' && selected.i === i;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(isSel ? 10 : 7, 12, 10),
      new THREE.MeshBasicMaterial({ color: isSel ? 0xffe14d : 0xffb14d }),
    );
    m.position.set(r.near[0], 6, r.near[1]);
    m.userData = { type: 'ramp', i };
    markerGroup.add(m);
  });
}

// ---------- validation (same math as scripts/check-width.mjs) ----------
function validate() {
  try {
    const g = buildTrackGeometry(def, 1);
    const S = g.sampleCount;
    let minMargin = Infinity;
    for (let i = 0; i < S; i++) {
      const t1 = g.tangents[i], t2 = g.tangents[(i + 1) % S];
      let da = Math.abs(Math.atan2(t1.x, t1.z) - Math.atan2(t2.x, t2.z));
      if (da > Math.PI) da = 2 * Math.PI - da;
      if (da < 1e-7) continue;
      minMargin = Math.min(minMargin, g.segLen / da - g.halfWidthAt(i));
    }
    const guard = Math.ceil((g.maxWidth * 1.6) / g.segLen);
    let minClear = Infinity;
    for (let i = 0; i < S; i += 4) {
      if (g.crossing[i]) continue;
      for (let j = i + guard; j < S; j += 4) {
        if (g.crossing[j]) continue;
        const w = Math.min(j - i, S - (j - i));
        if (w < guard) continue;
        const a = g.points[i], b = g.points[j];
        if (Math.abs(a.y - b.y) >= 4) continue;
        minClear = Math.min(minClear, Math.hypot(a.x - b.x, a.z - b.z) - (g.widths[i] + g.widths[j]) / 2);
      }
    }
    const zones = g.crossing.reduce((a, c, i) => a + (c && !g.crossing[(i - 1 + S) % S] ? 1 : 0), 0);
    const radOk = minMargin > 3;
    const clearOk = minClear === Infinity || minClear > 6;
    $('validation').innerHTML = [
      `length: ${g.length.toFixed(0)}u · ~${(g.length / 75).toFixed(0)}s/lap`,
      `<span class="${radOk ? 'ok' : 'bad'}">corner radius margin: ${minMargin.toFixed(1)}u ${radOk ? '✓' : '— too tight for road width!'}</span>`,
      `<span class="${clearOk ? 'ok' : 'bad'}">branch clearance: ${minClear === Infinity ? '∞' : minClear.toFixed(1) + 'u'} ${clearOk ? '✓' : '— roads too close (not a crossing)!'}</span>`,
      `intersection zones: ${zones}`,
      `ramps: ${def.ramps?.length ?? 0}`,
    ].join('<br/>');
  } catch (e) {
    $('validation').innerHTML = `<span class="bad">${e.message}</span>`;
  }
}

// ---------- picking / dragging ----------
const ray = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let drag = null; // { kind: 'point'|'ramp'|'pan', i?, startPan?, startPt? }

function pointerWorld(e) {
  const ndc = new THREE.Vector2(
    (e.clientX / innerWidth) * 2 - 1,
    -(e.clientY / innerHeight) * 2 + 1,
  );
  ray.setFromCamera(ndc, camera);
  const out = new THREE.Vector3();
  ray.ray.intersectPlane(groundPlane, out);
  return out;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.clientX > innerWidth - 300) return;
  const w = pointerWorld(e);
  if (placingRamp) {
    def.ramps = def.ramps ?? [];
    def.ramps.push({ near: [Math.round(w.x), Math.round(w.z)], len: 34, h: 6.5 });
    selected = { type: 'ramp', i: def.ramps.length - 1 };
    placingRamp = false;
    $('status').textContent = '';
    scheduleRebuild(true);
    return;
  }
  if (placingDecor) {
    def.decor = def.decor ?? [];
    def.decor.push({ type: placingDecor, at: [Math.round(w.x), Math.round(w.z)] });
    selected = { type: 'decor', i: def.decor.length - 1 };
    placingDecor = null;
    $('status').textContent = '';
    scheduleRebuild(true);
    return;
  }
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(markerGroup.children)[0];
  if (hit) {
    selected = { ...hit.object.userData };
    drag = { kind: selected.type, i: selected.i };
    refreshMarkers();
    refreshPanel();
  } else {
    selected = null;
    drag = { kind: 'pan', px: e.clientX, pz: e.clientY, panX, panZ };
    refreshMarkers();
    refreshPanel();
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'pan') {
    panX = drag.panX - (e.clientX - drag.px) / zoom;
    panZ = drag.panZ - (e.clientY - drag.pz) / zoom;
    updateCamera();
    return;
  }
  const w = pointerWorld(e);
  if (drag.kind === 'point') {
    def.points[drag.i][0] = Math.round(w.x);
    def.points[drag.i][1] = Math.round(w.z);
  } else if (drag.kind === 'ramp') {
    def.ramps[drag.i].near = [Math.round(w.x), Math.round(w.z)];
  } else if (drag.kind === 'decor') {
    def.decor[drag.i].at = [Math.round(w.x), Math.round(w.z)];
  }
  scheduleRebuild();
});

addEventListener('pointerup', () => { drag = null; });

// Double-click inserts a point into the nearest segment, right where clicked.
renderer.domElement.addEventListener('dblclick', (e) => {
  if (e.clientX > innerWidth - 300) return;
  const w = pointerWorld(e);
  const n = def.points.length;
  let bestSeg = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const a = def.points[i], b = def.points[(i + 1) % n];
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const len2 = abx * abx + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((w.x - a[0]) * abx + (w.z - a[1]) * abz) / len2));
    const d = Math.hypot(w.x - (a[0] + abx * t), w.z - (a[1] + abz * t));
    if (d < bestD) { bestD = d; bestSeg = i; }
  }
  const a = def.points[bestSeg], b = def.points[(bestSeg + 1) % n];
  def.points.splice(bestSeg + 1, 0, [
    Math.round(w.x), Math.round(w.z),
    ((a[2] ?? 0) + (b[2] ?? 0)) / 2, ((a[3] ?? 38) + (b[3] ?? 38)) / 2,
  ]);
  selected = { type: 'point', i: bestSeg + 1 };
  scheduleRebuild(true);
});

renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = Math.min(4, Math.max(0.12, zoom * (e.deltaY > 0 ? 0.9 : 1.11)));
  updateCamera();
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.code === 'Delete' || e.code === 'Backspace') {
    if (document.activeElement?.tagName === 'INPUT') return;
    deleteSelected();
  }
});

function deleteSelected() {
  if (!selected) return;
  if (selected.type === 'point' && def.points.length > 4) def.points.splice(selected.i, 1);
  if (selected.type === 'ramp') def.ramps.splice(selected.i, 1);
  if (selected.type === 'decor') def.decor.splice(selected.i, 1);
  selected = null;
  scheduleRebuild(true);
}

// ---------- panel ----------
function refreshPanel() {
  $('t-name').value = def.name ?? '';
  $('t-blurb').value = def.blurb ?? '';

  const isPt = selected?.type === 'point';
  $('sec-point').style.display = isPt ? 'block' : 'none';
  if (isPt) {
    const p = def.points[selected.i];
    $('p-idx').textContent = `#${selected.i + 1} / ${def.points.length}`;
    $('p-x').value = p[0]; $('p-z').value = p[1];
    $('p-y').value = p[2] ?? 0; $('p-w').value = p[3] ?? 38;
  }

  const isRamp = selected?.type === 'ramp';
  $('sec-ramp').style.display = isRamp ? 'block' : 'none';
  if (isRamp) {
    const r = def.ramps[selected.i];
    $('r-idx').textContent = `#${selected.i + 1}`;
    $('r-len').value = r.len; $('r-h').value = r.h;
    const mode = r.w === 'full' ? 'full' : typeof r.w === 'number' ? 'custom' : 'lane';
    $('r-w').value = mode;
    $('r-wc-row').style.display = mode === 'custom' ? 'flex' : 'none';
    if (mode === 'custom') $('r-wc').value = r.w;
    $('r-lane-row').style.display = mode === 'full' ? 'none' : 'flex';
    $('r-lane').value = typeof r.lane === 'number' ? String(r.lane) : 'random';
    $('r-dir-mode').value = r.dir != null ? 'manual' : 'auto';
    $('r-dir-row').style.display = r.dir != null ? 'flex' : 'none';
    if (r.dir != null) $('r-dir').value = r.dir;
  }

  const isDecor = selected?.type === 'decor';
  $('sec-decor').style.display = isDecor ? 'block' : 'none';
  if (isDecor) {
    const d = def.decor[selected.i];
    $('d-type').textContent = d.type.toUpperCase();
    const defaults = { wall: [30, 3], block: [14, 10], arch: [46, 11], pylon: [0, 8] };
    $('d-len-row').style.display = d.type === 'pylon' ? 'none' : 'flex';
    $('d-len').value = d.len ?? defaults[d.type][0];
    $('d-h').value = d.h ?? defaults[d.type][1];
    $('d-dir-mode').value = d.dir != null ? 'manual' : 'auto';
    $('d-dir-row').style.display = d.dir != null ? 'flex' : 'none';
    if (d.dir != null) $('d-dir').value = d.dir;
  }

  $('ramp-list').innerHTML = (def.ramps ?? []).map((r, i) =>
    `<div class="ramp-row${isRamp && selected.i === i ? ' selected' : ''}" data-i="${i}">
      ramp ${i + 1} · ${r.w === 'full' ? 'FULL' : typeof r.w === 'number' ? r.w + 'u' : 'lane'}${typeof r.lane === 'number' ? ' ' + (r.lane > 0 ? 'L' : r.lane < 0 ? 'R' : 'C') : ''} · len ${r.len} · h ${r.h}
    </div>`).join('') || '<span class="hint">none — add one</span>';
  for (const row of document.querySelectorAll('.ramp-row')) {
    row.onclick = () => { selected = { type: 'ramp', i: +row.dataset.i }; refreshMarkers(); refreshPanel(); };
  }
}

// panel inputs
$('t-name').oninput = (e) => { def.name = e.target.value.toUpperCase(); saveDraft(); };
$('t-blurb').oninput = (e) => { def.blurb = e.target.value; saveDraft(); };
$('t-template').onchange = (e) => {
  const v = e.target.value;
  if (!v) return;
  if (v === 'oval') def = blankOval();
  else {
    const t = TRACKS.find((t2) => t2.id === v);
    def = JSON.parse(JSON.stringify({ name: t.name + ' COPY', blurb: t.blurb, points: t.points, ramps: t.ramps ?? [], decor: t.decor ?? [] }));
  }
  selected = null;
  e.target.value = '';
  scheduleRebuild(true);
};
for (const [id, slot] of [['p-x', 0], ['p-z', 1], ['p-y', 2], ['p-w', 3]]) {
  $(id).oninput = (e) => {
    if (selected?.type !== 'point') return;
    const p = def.points[selected.i];
    while (p.length < 4) p.push(p.length === 2 ? 0 : 38);
    p[slot] = +e.target.value || 0;
    scheduleRebuild();
  };
}
$('p-insert').onclick = () => {
  if (selected?.type !== 'point') return;
  const i = selected.i, n = def.points.length;
  const a = def.points[i], b = def.points[(i + 1) % n];
  def.points.splice(i + 1, 0, [
    Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2),
    ((a[2] ?? 0) + (b[2] ?? 0)) / 2, ((a[3] ?? 38) + (b[3] ?? 38)) / 2,
  ]);
  selected = { type: 'point', i: i + 1 };
  scheduleRebuild(true);
};
$('p-delete').onclick = deleteSelected;
$('r-delete').onclick = deleteSelected;
$('r-len').oninput = (e) => { if (selected?.type === 'ramp') { def.ramps[selected.i].len = +e.target.value || 30; scheduleRebuild(); } };
$('r-h').oninput = (e) => { if (selected?.type === 'ramp') { def.ramps[selected.i].h = +e.target.value || 6; scheduleRebuild(); } };
$('r-w').onchange = (e) => {
  if (selected?.type !== 'ramp') return;
  const r = def.ramps[selected.i];
  if (e.target.value === 'full') r.w = 'full';
  else if (e.target.value === 'custom') r.w = 14;
  else delete r.w;
  scheduleRebuild(true);
};
$('r-wc').oninput = (e) => { if (selected?.type === 'ramp') { def.ramps[selected.i].w = +e.target.value || 14; scheduleRebuild(); } };
$('r-lane').onchange = (e) => {
  if (selected?.type !== 'ramp') return;
  const r = def.ramps[selected.i];
  if (e.target.value === 'random') delete r.lane;
  else r.lane = +e.target.value;
  scheduleRebuild(true);
};
$('r-dir-mode').onchange = (e) => {
  if (selected?.type !== 'ramp') return;
  const r = def.ramps[selected.i];
  if (e.target.value === 'manual') r.dir = 0; else delete r.dir;
  scheduleRebuild(true);
};
$('r-dir').oninput = (e) => { if (selected?.type === 'ramp') { def.ramps[selected.i].dir = +e.target.value || 0; scheduleRebuild(); } };
for (const btn of document.querySelectorAll('[data-decor]')) {
  btn.onclick = () => {
    placingDecor = btn.dataset.decor;
    placingRamp = false;
    $('status').textContent = `click the map to place the ${placingDecor}`;
  };
}
$('d-len').oninput = (e) => { if (selected?.type === 'decor') { def.decor[selected.i].len = +e.target.value || 20; scheduleRebuild(); } };
$('d-h').oninput = (e) => { if (selected?.type === 'decor') { def.decor[selected.i].h = +e.target.value || 5; scheduleRebuild(); } };
$('d-dir-mode').onchange = (e) => {
  if (selected?.type !== 'decor') return;
  const d = def.decor[selected.i];
  if (e.target.value === 'manual') d.dir = 0; else delete d.dir;
  scheduleRebuild(true);
};
$('d-dir').oninput = (e) => { if (selected?.type === 'decor') { def.decor[selected.i].dir = +e.target.value || 0; scheduleRebuild(); } };
$('d-delete').onclick = deleteSelected;

$('r-add').onclick = () => {
  placingRamp = true;
  $('status').textContent = 'click the map to place the ramp';
};

// ---------- export / import ----------
function exportJson() {
  return JSON.stringify({
    format: 'drift-circuit-track',
    version: 1,
    id: 'custom-' + (def.name ?? 'track').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: def.name || 'CUSTOM TRACK',
    blurb: def.blurb || 'custom',
    points: def.points,
    ramps: def.ramps ?? [],
    decor: def.decor ?? [],
  }, null, 1);
}

$('f-test').onclick = () => {
  saveDraft();
  location.href = './?testdrive=1'; // the game picks the draft up from localStorage
};

$('f-export').onclick = () => {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (def.name || 'track').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('f-copy').onclick = () => navigator.clipboard?.writeText(exportJson());
$('f-import').onclick = () => $('f-file').click();
$('f-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.points) || d.points.length < 4) throw new Error('bad file: needs points[]');
    def = { name: d.name ?? 'IMPORTED', blurb: d.blurb ?? '', points: d.points, ramps: d.ramps ?? [], decor: d.decor ?? [] };
    selected = null;
    scheduleRebuild(true);
  } catch (err) {
    $('status').textContent = 'import failed: ' + err.message;
  }
  e.target.value = '';
};

// ---------- loop ----------
rebuildTrack();
refreshMarkers();
refreshPanel();
renderer.setAnimationLoop(() => {
  waveT += 1 / 60;
  track?.tick(waveT);
  renderer.render(scene, camera);
});
