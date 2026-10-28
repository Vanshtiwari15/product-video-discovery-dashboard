import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createFrameSampler, resolveFfmpeg } from '../src/brain/frames.js';
import { createScorer } from '../src/brain/score.js';
import { colorHistogram, l2normalize } from '../src/brain/imageUtils.js';

const run = promisify(execFile);
const ffmpeg = await resolveFfmpeg('');
const hasFfmpeg = await run(ffmpeg, ['-version']).then(() => true, () => false);

const solid = (r, g, b) => sharp({ create: { width: 320, height: 568, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
const productImage = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="568"><rect width="320" height="568" fill="#f4f4f4"/><rect x="60" y="120" width="200" height="320" fill="#1d3b8a"/><circle cx="160" cy="280" r="60" fill="#e8d9b0"/></svg>')).jpeg().toBuffer();

const frameConfig = { frames: { enabled: true, count: 5, everySeconds: 3, maxPerBatch: 8, confidentAbove: 0.85, maxVideoBytes: 50e6, ffmpegPath: '' } };
const stubEmbedder = { embedImage: async (b) => ({ kind: 'clip', vector: l2normalize(await colorHistogram(b)) }), embedTexts: async () => null };

test('frame sampler extracts frames from a real video and the scorer keeps the best frame', { skip: !hasFfmpeg && 'ffmpeg not available' }, async () => {
  // 9-second video: title card (orange), then the product, then an unrelated scene (green).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-video-'));
  const parts = [await solid(230, 120, 30), await productImage(), await solid(40, 140, 60)];
  parts.forEach((buffer, i) => fs.writeFileSync(path.join(dir, `p${i}.jpg`), buffer));
  fs.writeFileSync(path.join(dir, 'list.txt'), parts.map((_, i) => `file 'p${i}.jpg'\nduration 3`).join('\n') + `\nfile 'p2.jpg'\n`);
  const video = path.join(dir, 'video.mp4');
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', 'fps=10,format=yuv420p', '-c:v', 'libx264', video]);

  const sampler = createFrameSampler({ config: frameConfig, fetchVideo: async () => fs.readFileSync(video) });
  const frames = await sampler.sample('local-test-video');
  assert.ok(frames.length >= 3, `got ${frames.length} frames`);

  const config = { ...frameConfig, vision: { anthropicKey: '', verifyWithVlm: false, vlmMode: 'ambiguous', vlmBand: [0.2, 0.9], matchThreshold: 55, clipImageRange: [0.3, 0.95], clipTextRange: [0.2, 0.3], vlmBatchSize: 4 } };
  const product = await productImage();
  const withFrames = createScorer({ embedder: stubEmbedder, config, logger: console, frameSampler: sampler, product: { imageBuffer: product, title: 'Blue product', attributes: {} } });
  const coverOnly = createScorer({ embedder: stubEmbedder, config: { ...config, frames: { ...config.frames, enabled: false } }, logger: console, product: { imageBuffer: product, title: 'Blue product', attributes: {} } });

  const candidate = { thumbnailBuffer: parts[0], caption: '', videoUrl: 'local-test-video' };
  const [cover] = await coverOnly([candidate]);
  const [best] = await withFrames([candidate]);
  assert.ok(best.score > cover.score + 30, `frame score ${best.score} vs cover ${cover.score}`);
  assert.equal(best.detail.frame.second, 3);
  assert.ok(best.frameBuffer);
  assert.ok(best.detail.reasons.some((r) => r.includes('frame at about 3 s')));
  assert.equal(withFrames.usage.framesSampled, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('frame sampling failure falls back to the cover image and says so', async () => {
  const config = { ...frameConfig, vision: { anthropicKey: '', verifyWithVlm: false, vlmMode: 'ambiguous', vlmBand: [0.2, 0.9], matchThreshold: 55, clipImageRange: [0.3, 0.95], clipTextRange: [0.2, 0.3], vlmBatchSize: 4 } };
  const sampler = { sample: async () => { throw new Error('HTTP 403 from CDN'); } };
  const scorer = createScorer({ embedder: stubEmbedder, config, logger: console, frameSampler: sampler, product: { imageBuffer: await productImage(), title: 'x', attributes: {} } });
  const [result] = await scorer([{ thumbnailBuffer: await solid(10, 10, 10), videoUrl: 'https://cdn.example.com/v.mp4' }]);
  assert.notEqual(result.score, null);
  assert.ok(result.detail.reasons.some((r) => r.includes('Frame sampling failed (HTTP 403 from CDN)')));
});
