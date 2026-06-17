/**
 * UUIDv7 implementation — monotonic, time-ordered, compatible with LMArena.
 *
 * Layout (128 bits):
 *   48 bits  unix ms
 *   4 bits   version (0111)
 *   12 bits  random
 *   2 bits   variant (10)
 *   62 bits  random
 */

let _lastMs = 0;
let _seq = 0;

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

export function uuidv7(): string {
  let ms = Date.now();
  if (ms <= _lastMs) {
    _seq++;
    ms = _lastMs;
  } else {
    _seq = 0;
    _lastMs = ms;
  }

  const rand = randomBytes(10);

  // 48-bit timestamp (big-endian)
  const b = new Uint8Array(16);
  b[0] = (ms / 2 ** 40) & 0xff;
  b[1] = (ms / 2 ** 32) & 0xff;
  b[2] = (ms / 2 ** 24) & 0xff;
  b[3] = (ms / 2 ** 16) & 0xff;
  b[4] = (ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;

  // version 7 + 12-bit seq
  b[6] = 0x70 | ((_seq >> 8) & 0x0f);
  b[7] = _seq & 0xff;

  // variant 10 + random
  b[8] = 0x80 | (rand[0] & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = rand[i - 7];

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
