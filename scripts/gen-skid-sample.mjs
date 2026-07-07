// Renders a seamless-looping tire-squeal sample to public/sfx/skid.wav.
// Offline DSP: inharmonic partial stack with pitch random-walk, stick-slip
// amplitude flutter with dropouts, and a bandpassed scrub floor — organic
// texture no realtime node graph matched.
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 44100;
const LOOP = 3.0;           // seconds in the final loop
const XFADE = 0.25;         // crossfaded seam
const N = Math.round(SR * (LOOP + XFADE));

// deterministic rng so the asset is reproducible
let seed = 1234567;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// one-pole lowpass helper for control signals
const lp = (alpha) => {
  let y = 0;
  return (x) => (y += alpha * (x - y));
};

const out = new Float32Array(N);

// Squeal = NOISE ringing through narrow resonators (not clean harmonics —
// those sound like a human voice). Two detuned fundamentals (two tires) plus
// weaker overtone resonators, all excited by white noise, pitch wandering.
function resonator() {
  let y1 = 0, y2 = 0;
  return (x, freq, q) => {
    const w = (2 * Math.PI * freq) / SR;
    const r = Math.max(0.9, 1 - w / (2 * q));
    const y = 2 * r * Math.cos(w) * y1 - r * r * y2 + x * (1 - r);
    y2 = y1; y1 = y;
    return y;
  };
}
const voices = [
  { res: resonator(), ratio: 1.0, q: 42, g: 1.0 },
  { res: resonator(), ratio: 1.045, q: 42, g: 0.9 },  // second tire, detuned
  { res: resonator(), ratio: 2.0, q: 22, g: 0.4 },
  { res: resonator(), ratio: 2.09, q: 22, g: 0.32 },
  { res: resonator(), ratio: 3.02, q: 16, g: 0.18 },
];
let pitchW = 0;
let ampW = 0.8;
let flutterPhase = rand() * 6.28;
const scrubLo = lp(0.12);
const scrubHi = lp(0.015);

for (let i = 0; i < N; i++) {
  pitchW += (rand() - 0.5) * 0.00045;
  pitchW = Math.max(-0.05, Math.min(0.05, pitchW)) * 0.99995;
  ampW += (rand() - 0.5) * 0.0016;
  ampW = Math.max(0.6, Math.min(1, ampW));
  flutterPhase += (2 * Math.PI * 15.5) / SR;
  const flutter = 0.86 + 0.14 * Math.sin(flutterPhase + Math.sin(flutterPhase * 0.37) * 2);

  const f0 = 780 * (1 + pitchW);
  const x = rand() * 2 - 1;
  let s = 0;
  for (const v of voices) s += v.res(x, f0 * v.ratio, v.q) * v.g;
  s *= ampW * flutter * 9.0;

  const n = rand() * 2 - 1;
  s += (scrubLo(n) - scrubHi(n)) * 0.12;
  out[i] = s;
}

// normalize
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
for (let i = 0; i < N; i++) out[i] = Math.tanh((out[i] / peak) * 1.6) * 0.85;

// crossfade the seam: blend the tail into the head
const nx = Math.round(SR * XFADE);
const loopN = N - nx;
const final = new Float32Array(loopN);
for (let i = 0; i < loopN; i++) final[i] = out[i];
for (let i = 0; i < nx; i++) {
  const t = i / nx;
  final[i] = out[loopN + i] * (1 - t) + out[i] * t;
}

// write 16-bit PCM WAV
const pcm = new Int16Array(loopN);
for (let i = 0; i < loopN; i++) pcm[i] = Math.max(-1, Math.min(1, final[i])) * 32767;
const dataSize = pcm.length * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
Buffer.from(pcm.buffer).copy(buf, 44);
mkdirSync('public/sfx', { recursive: true });
writeFileSync('public/sfx/skid.wav', buf);
console.log(`wrote public/sfx/skid.wav (${(buf.length / 1024).toFixed(0)} KB, ${LOOP}s loop)`);
