'use strict';

/**
 * Generates public/sounds/buzzer.wav locally so the app ships with no
 * downloaded audio asset. Re-run with `npm run make-sound`.
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION = 0.85;
const OUT = path.join(__dirname, '..', 'public', 'sounds', 'buzzer.wav');

function sample(t) {
  // Two detuned square waves -> classic harsh game-show buzz.
  const square = (freq) => (Math.sin(2 * Math.PI * freq * t) >= 0 ? 1 : -1);
  const body = 0.6 * square(196) + 0.3 * square(147) + 0.18 * square(392);

  // Slight tremolo gives it the "brrrrt" character.
  const tremolo = 0.82 + 0.18 * Math.sin(2 * Math.PI * 28 * t);

  // Fast attack, long-ish decay, hard fade at the tail to avoid a click.
  const attack = Math.min(1, t / 0.006);
  const decay = Math.exp(-2.6 * t);
  const tail = Math.min(1, (DURATION - t) / 0.05);

  return body * tremolo * attack * decay * Math.max(0, tail);
}

const frameCount = Math.floor(SAMPLE_RATE * DURATION);
const data = Buffer.alloc(frameCount * 2);
for (let i = 0; i < frameCount; i += 1) {
  const value = Math.max(-1, Math.min(1, sample(i / SAMPLE_RATE) * 0.9));
  data.writeInt16LE(Math.round(value * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, data]));
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
