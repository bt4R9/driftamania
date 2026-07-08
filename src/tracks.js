// Built-in track roster. NOSTALGIA is the hand-made circuit maintained in
// src/my-track.json (exported from the editor); new tracks are authored in
// the editor and imported the same way. Ramps are free objects: lane-sized
// by default (seeded lane), or w:'full' spanning the road.

import myTrack from './my-track.json' with { type: 'json' };

export const TRACKS = [
  {
    id: 'mytrack',
    name: 'NOSTALGIA',
    blurb: myTrack.blurb || 'custom',
    points: myTrack.points,
    ramps: myTrack.ramps ?? [],
    decor: myTrack.decor ?? [],
  },
];

export function trackById(id) {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
