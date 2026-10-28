// Labelled accuracy benchmark for the scorer: exact product vs similar product vs unrelated.
// Free with CLIP only. With --vlm it calls Claude (paid) and requires --yes.
// Usage: npm run benchmark:brain -- [--products 8] [--vlm --yes]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { createEmbedder } from '../src/brain/embedder.js';
import { createScorer } from '../src/brain/score.js';
import { DEFAULT_STORE, loadCatalogue } from './lib/benchmarkImages.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const productCount = Number(value('products', 8));
const useVlm = flag('vlm');
if (useVlm && !config.vision.anthropicKey) throw new Error('--vlm needs ANTHROPIC_API_KEY in backend/.env');
if (useVlm && !flag('yes')) {
  console.log(`--vlm sends about ${productCount * 11} candidate images (in batches of ${config.vision.vlmBatchSize}) to ${config.vision.anthropicModel}. This costs money. Re-run with --yes to proceed.`);
  process.exit(2);
}

const runConfig = { ...config, frames: { ...config.frames, enabled: false }, vision: { ...config.vision, verifyWithVlm: useVlm, ...(useVlm ? {} : { geminiKey: '', anthropicKey: '', fallbackVlm: {} }) } };
const embedder = createEmbedder({ config: runConfig, logger });
const backend = await embedder.method();
console.log(`Scoring backend: ${backend}${embedder.fallbackReason ? ` (${embedder.fallbackReason})` : ''}${useVlm ? ` + Claude ${config.vision.anthropicModel} (${config.vision.vlmMode})` : ''}`);

const { boards, unrelated, image } = await loadCatalogue(DEFAULT_STORE, path.join(config.dataDir, 'benchmark'));
const refs = boards.slice(0, productCount);
const rows = [];
const usage = { vlmCalls: 0, vlmInputTokens: 0, vlmOutputTokens: 0 };

for (const [r, ref] of refs.entries()) {
  const others = boards.filter((b) => b.handle !== ref.handle);
  const candidates = [
    ...ref.images.slice(1, 3).map((img, i) => ({ label: 'exact', note: `${ref.handle} photo ${i + 2}`, load: () => image(ref.handle, i + 1, img.src) })),
    ...others.slice(r, r + 6).map((b) => ({ label: 'similar', note: `${b.handle} in-scene photo`, load: () => image(b.handle, 2, b.images[2].src) })),
    ...others.slice(r + 6, r + 8).map((b) => ({ label: 'similar', note: `${b.handle} packshot`, load: () => image(b.handle, 0, b.images[0].src) })),
    ...unrelated.map((u) => ({ label: 'unrelated', note: u.handle, load: () => image(u.handle, 0, u.images[0].src) })),
  ];
  const buffers = await Promise.all(candidates.map((c) => c.load()));
  const scorer = createScorer({ embedder, config: runConfig, logger, product: { imageBuffer: await image(ref.handle, 0, ref.images[0].src), title: ref.title, attributes: {} } });
  const results = await scorer(buffers.map((b) => ({ thumbnailBuffer: b, caption: '' })));
  Object.keys(usage).forEach((k) => (usage[k] += scorer.usage[k]));
  results.forEach((res, i) => rows.push({ reference: ref.handle, ...candidates[i], load: undefined, score: res.score, cosine: res.detail.imageCosine, vlm: res.detail.vlm?.verdict ?? null, summary: res.detail.summary }));
  process.stdout.write(`${ref.handle}: ${results.map((x, i) => `${candidates[i].label[0]}${x.score}`).join(' ')}\n`);
}

const byLabel = (label) => rows.filter((row) => row.label === label).map((row) => row.score);
const stats = (scores) => (scores.length ? { n: scores.length, mean: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), min: Math.min(...scores), max: Math.max(...scores) } : { n: 0 });
const acceptRate = (scores, t) => (scores.length ? Math.round((100 * scores.filter((s) => s >= t).length) / scores.length) : 0);
const threshold = config.vision.matchThreshold;
const exact = byLabel('exact');
const negatives = [...byLabel('similar'), ...byLabel('unrelated')];
let best = { t: threshold, balanced: -1 };
for (let t = 0; t <= 100; t += 1) {
  const balanced = (exact.filter((s) => s >= t).length / exact.length + negatives.filter((s) => s < t).length / negatives.length) / 2;
  if (balanced > best.balanced) best = { t, balanced };
}
const top1 = refs.filter((ref) => {
  const own = rows.filter((row) => row.reference === ref.handle).sort((a, b) => b.score - a.score);
  return own[0]?.label === 'exact';
}).length;

const report = `# Brain benchmark

Generated ${new Date().toISOString()} with \`npm run benchmark:brain${useVlm ? ' -- --vlm --yes' : ''}\`.
Backend: **${backend}**${embedder.fallbackReason ? ` (fallback: ${embedder.fallbackReason})` : ''}${useVlm ? ` + Claude \`${config.vision.anthropicModel}\` (${config.vision.vlmMode} band ${config.vision.vlmBand.join('-')})` : ''}.
Images: ${DEFAULT_STORE} (Shopify's public demo catalogue). Reference = packshot. Exact = other photos of the same board.
Similar = other boards (in-scene photos and packshots). Unrelated = wax products.

| Class | n | Mean | Min | Max | Accepted at threshold ${threshold} |
|--|--|--|--|--|--|
${['exact', 'similar', 'unrelated'].map((l) => { const s = stats(byLabel(l)); return `| ${l} | ${s.n} | ${s.mean ?? '-'} | ${s.min ?? '-'} | ${s.max ?? '-'} | ${acceptRate(byLabel(l), threshold)}% |`; }).join('\n')}

- Top-1 retrieval (an exact photo ranked first among that reference's candidates): **${top1}/${refs.length}**
- Best single threshold on this set: **${best.t}** (balanced accuracy ${Math.round(best.balanced * 100)}%)
${useVlm ? `- Claude usage: ${usage.vlmCalls} calls, ${usage.vlmInputTokens} input tokens, ${usage.vlmOutputTokens} output tokens\n` : ''}
## All scores

| Reference | Class | Candidate | Score | CLIP cosine | Claude | Explanation |
|--|--|--|--|--|--|--|
${rows.map((row) => `| ${row.reference} | ${row.label} | ${row.note} | ${row.score} | ${row.cosine ?? '-'} | ${row.vlm ?? '-'} | ${(row.summary || '').replace(/\|/g, '/')} |`).join('\n')}
`;
const out = path.resolve('..', 'evaluation', `brain-benchmark-${backend}${useVlm ? '-claude' : ''}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, report);
console.log(`\nexact ${JSON.stringify(stats(exact))}, similar ${JSON.stringify(stats(byLabel('similar')))}, unrelated ${JSON.stringify(stats(byLabel('unrelated')))}`);
console.log(`top-1 ${top1}/${refs.length}, best threshold ${best.t} (balanced ${Math.round(best.balanced * 100)}%)`);
console.log(`Wrote ${out}`);
