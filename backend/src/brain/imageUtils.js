import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// Every stored image is a JPEG of at most 512px so scoring, hashing and the VLM see the same pixels.
export async function normalizeImage(buffer) {
  try {
    return await sharp(buffer, { failOn: 'error' }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
  } catch {
    throw new Error('File is not a readable image');
  }
}

export async function saveMedia(dir, buffer) {
  const hash = sha256(buffer);
  await fs.mkdir(dir, { recursive: true });
  const file = `${hash.slice(0, 32)}.jpg`;
  await fs.writeFile(path.join(dir, file), buffer);
  return { hash, file };
}

// 64-bit difference hash. Robust to re-encoding and resizing; used for near-duplicate detection.
export async function dHash(buffer) {
  const pixels = await sharp(buffer).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      bits = (bits << 1n) | (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(hexA, hexB) {
  let diff = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

const isBackground = (r, g, b) => r > 236 && g > 236 && b > 236;

// 4x4x4 RGB histogram of the centre crop, ignoring near-white studio backgrounds.
// Soft (trilinear) binning: each pixel is shared between neighbouring bins, so JPEG noise near a bin edge
// does not move the whole pixel into another bin.
function softBins(value) {
  const position = Math.min(Math.max(value / 64 - 0.5, 0), 3);
  const low = Math.floor(position);
  const weight = position - low;
  return low >= 3 ? [[3, 1]] : [[low, 1 - weight], [low + 1, weight]];
}

export async function colorHistogram(buffer) {
  const { data } = await sharp(buffer).resize(64, 64, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Float64Array(64);
  let counted = 0;
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (isBackground(r, g, b)) continue;
    for (const [ri, rw] of softBins(r)) for (const [gi, gw] of softBins(g)) for (const [bi, bw] of softBins(b)) bins[ri * 16 + gi * 4 + bi] += rw * gw * bw;
    counted += 1;
  }
  if (counted) for (let i = 0; i < 64; i += 1) bins[i] /= counted;
  return bins;
}

export function histogramIntersection(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.min(a[i], b[i]);
  return sum;
}

const NAMED_COLORS = {
  black: [20, 20, 20], white: [245, 245, 245], grey: [128, 128, 128], red: [200, 30, 40], maroon: [110, 20, 30],
  orange: [235, 120, 30], yellow: [235, 210, 50], olive: [120, 120, 40], green: [50, 150, 60], teal: [20, 128, 128],
  blue: [40, 90, 200], navy: [20, 30, 90], purple: [120, 50, 150], pink: [235, 130, 170], brown: [120, 75, 40], beige: [220, 200, 160],
};

function nearestColorName([r, g, b]) {
  let best = 'grey';
  let bestDistance = Infinity;
  for (const [name, [cr, cg, cb]] of Object.entries(NAMED_COLORS)) {
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [name, distance];
  }
  return best;
}

export function dominantColors(histogram, limit = 4) {
  const byName = new Map();
  histogram.forEach((share, index) => {
    if (!share) return;
    const center = [(index >> 4) * 64 + 32, ((index >> 2) & 3) * 64 + 32, (index & 3) * 64 + 32];
    const name = nearestColorName(center);
    byName.set(name, (byName.get(name) || 0) + share);
  });
  return [...byName.entries()]
    .filter(([, share]) => share >= 0.06)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, share]) => ({ name, share: Math.round(share * 100) / 100 }));
}

// Fingerprint = 64-bit dHash + quantised colour histogram ("<16 hex>.<128 hex>").
// dHash alone collides on studio packshots that share a layout (measured distance 4-6 between different
// products), so a near-duplicate must also keep >= 90% colour overlap. See README, De-duplication.
export async function fingerprint(buffer) {
  const hist = await colorHistogram(buffer);
  const colour = Array.from(hist, (share) => Math.min(255, Math.round(share * 255)).toString(16).padStart(2, '0')).join('');
  return `${await dHash(buffer)}.${colour}`;
}

function parseFingerprint(value) {
  const [hash, colour] = String(value).split('.');
  const hist = colour?.length === 128 ? Float64Array.from({ length: 64 }, (_, i) => parseInt(colour.slice(i * 2, i * 2 + 2), 16) / 255) : null;
  return { hash, hist };
}

export function isNearDuplicate(a, b, { maxHamming = 8, minColourOverlap = 0.9 } = {}) {
  if (!a || !b) return false;
  const fa = parseFingerprint(a);
  const fb = parseFingerprint(b);
  if (hammingDistance(fa.hash, fb.hash) > maxHamming) return false;
  return !fa.hist || !fb.hist || histogramIntersection(fa.hist, fb.hist) >= minColourOverlap;
}

// Zero-mean 16x16 grayscale vector; only used by the basic fallback backend.
export async function structureVector(buffer) {
  const pixels = await sharp(buffer).grayscale().resize(16, 16, { fit: 'cover' }).raw().toBuffer();
  const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  return l2normalize(Float32Array.from(pixels, (value) => value - mean));
}

export function l2normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(vector, (value) => value / norm);
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}
