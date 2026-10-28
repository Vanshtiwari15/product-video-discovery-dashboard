// Free check that CLIP really loads and produces sensible image embeddings.
// Usage: npm run verify:clip
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { createEmbedder } from '../src/brain/embedder.js';
import { cosine } from '../src/brain/imageUtils.js';
import path from 'node:path';
import { DEFAULT_STORE, loadCatalogue } from './lib/benchmarkImages.mjs';

const embedder = createEmbedder({ config: { ...config, vision: { ...config.vision, backend: 'clip' } }, logger });
const started = Date.now();
const method = await embedder.method();
if (method !== 'clip') {
  console.error(`FAIL: CLIP did not load. ${embedder.fallbackReason}`);
  process.exit(1);
}
console.log(`CLIP loaded (${config.vision.clipModel}) in ${((Date.now() - started) / 1000).toFixed(1)} s`);

const { boards, unrelated, image } = await loadCatalogue(DEFAULT_STORE, path.join(config.dataDir, 'benchmark'));
const [ref, other] = boards;
const samples = {
  [`${ref.handle} packshot (reference)`]: await image(ref.handle, 0, ref.images[0].src),
  [`${ref.handle} other photo`]: await image(ref.handle, 2, ref.images[2].src),
  [`${other.handle} other photo`]: await image(other.handle, 2, other.images[2].src),
  [`${unrelated[0].handle} (unrelated)`]: await image(unrelated[0].handle, 0, unrelated[0].images[0].src),
};
const names = Object.keys(samples);
const vectors = [];
for (const name of names) {
  const t = Date.now();
  const { kind, vector } = await embedder.embedImage(samples[name]);
  vectors.push(vector);
  console.log(`embedded ${name}: ${kind}, ${vector.length} dims, ${Date.now() - t} ms`);
}
console.log('\nCosine similarity to the reference packshot:');
names.slice(1).forEach((name, i) => console.log(`  ${cosine(vectors[0], vectors[i + 1]).toFixed(3)}  ${name}`));

const labels = ['snowboard', 'ski wax', 'tablecloth', 't-shirt', 'chocolate bar', 'sneakers'];
const textVectors = await embedder.embedTexts(labels.map((l) => `a photo of a ${l}`));
const ranked = labels.map((l, i) => [l, cosine(vectors[0], textVectors[i])]).sort((a, b) => b[1] - a[1]);
console.log(`\nZero-shot label for the reference: ${ranked[0][0]} (${ranked.map(([l, c]) => `${l} ${c.toFixed(3)}`).join(', ')})`);

const exact = cosine(vectors[0], vectors[1]);
const unrelatedCos = cosine(vectors[0], vectors[3]);
const ok = vectors[0].length === 512 && exact > unrelatedCos && ranked[0][0] === 'snowboard';
console.log(`\n${ok ? 'PASS' : 'FAIL'}: 512-dim embeddings, same product (${exact.toFixed(3)}) closer than unrelated (${unrelatedCos.toFixed(3)}), zero-shot = ${ranked[0][0]}`);
process.exit(ok ? 0 : 1);
