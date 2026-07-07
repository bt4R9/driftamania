// Track geometry validation: corner radii vs local half-width, same-level
// clearance outside intersections, intersection count.
import { buildTrackGeometry } from '../src/trackgeom.js';
import { TRACKS } from '../src/tracks.js';

for (const def of TRACKS) {
  const g = buildTrackGeometry(def, 7);
  const S = g.sampleCount;
  let bad = 0, minMargin = Infinity, minMarginAt = null;
  for (let i = 0; i < S; i++) {
    const t1 = g.tangents[i], t2 = g.tangents[(i + 1) % S];
    const a1 = Math.atan2(t1.x, t1.z), a2 = Math.atan2(t2.x, t2.z);
    let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
    if (da < 1e-7) continue;
    const r = g.segLen * Math.hypot(t1.x, t1.z) / da;
    const margin = r - g.halfWidthAt(i);
    if (margin < minMargin) { minMargin = margin; minMarginAt = g.points[i]; }
    if (margin < 1) bad++;
  }
  // clearance between non-adjacent same-level samples, excluding flagged crossings
  const guard = Math.ceil((g.maxWidth * 1.6) / g.segLen);
  let minClear = Infinity;
  for (let i = 0; i < S; i += 2) {
    if (g.crossing[i]) continue;
    for (let j = i + guard; j < S; j += 2) {
      if (g.crossing[j]) continue;
      const w = Math.min(j - i, S - (j - i));
      if (w < guard) continue;
      const a = g.points[i], b = g.points[j];
      if (Math.abs(a.y - b.y) >= 4) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const need = (g.widths[i] + g.widths[j]) / 2;
      minClear = Math.min(minClear, d - need);
    }
  }
  const nCross = g.crossing.reduce((acc, c, i) => acc + (c && !g.crossing[(i - 1 + S) % S] ? 1 : 0), 0);
  const ok = bad === 0 && (minClear === Infinity || minClear > 4);
  console.log(`${ok ? 'OK  ' : 'BAD '}${def.name.padEnd(15)} len=${g.length.toFixed(0)}u ` +
    `minRadiusMargin=${minMargin.toFixed(1)}u@(${minMarginAt.x.toFixed(0)},${minMarginAt.z.toFixed(0)}) ` +
    `clearanceMargin=${minClear === Infinity ? '∞' : minClear.toFixed(1)}u crossingZones=${nCross} ramps=${g.ramps.length}`);
}
