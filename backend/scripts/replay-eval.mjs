// Offline relevance check on real, already-collected candidates (no Apify, no Gemini calls).
// Usage: node scripts/replay-eval.mjs --pool labeled.json --image product.jpg --title "Stanley Quencher H2.0 40 oz tumbler" [--thumbs data/media/thumbs] [--old scripts/lib/original-score.js]
// labeled.json: [{ "thumb": "<file in thumbs dir>", "caption": "...", "author": "...", "platform": "instagram|meta", "label": "R|C|N" }]
// R = the searched product (or a colour/size variant), C = same product category only, N = irrelevant.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from '../src/config.js';
import { createEmbedder } from '../src/brain/embedder.js';
import { createScorer } from '../src/brain/score.js';
import { buildSearchPlan } from '../src/brain/plan.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const logger = pino({ level: 'warn' });
const poolFile = JSON.parse(fs.readFileSync(arg('pool'), 'utf8'));
const pool = Array.isArray(poolFile) ? poolFile : poolFile.candidates;
const thumbs = arg('thumbs', path.join(config.dataDir, 'media', 'thumbs'));
const imageBuffer = fs.readFileSync(arg('image'));
const title = arg('title');
const relevant = arg('relevant', 'R').split('');
const threshold = Number(arg('threshold', 55));
const embedder = createEmbedder({ config, logger });
const cfg = { ...config, frames: { ...config.frames, enabled: false }, vision: { ...config.vision, verifyWithVlm: false, matchThreshold: threshold } };
const plan = buildSearchPlan({ title, attributes: {}, scope: arg('scope', config.matchScope) });
const candidates = pool.map((e) => ({ thumbnailBuffer: fs.readFileSync(path.join(thumbs, e.thumb)), caption: e.caption, author: e.author, title: e.extra?.title || e.extraTitle || null }));
const isRel = (e) => relevant.includes(e.label);

function report(name, results) {
  const rows = pool.map((e, i) => ({ e, score: results[i].score ?? -1, status: results[i].matchStatus }));
  const total = rows.filter((r) => isRel(r.e)).length;
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  const at = (k) => ranked.slice(0, k).filter((r) => isRel(r.e)).length;
  const acc = rows.filter((r) => r.status === 'accepted');
  const accRel = acc.filter((r) => isRel(r.e)).length;
  return { name, relevantInPool: total, 'precision@10': `${at(10)}/10`, 'precision@20': `${at(20)}/20`, 'precision@40': `${at(40)}/40`, accepted: acc.length, acceptedRelevant: accRel, acceptedPrecision: acc.length ? `${Math.round((100 * accRel) / acc.length)}%` : 'n/a', recall: `${accRel}/${total}` };
}

const out = [];
let oldResults = null;
if (arg('old')) {
  const { createScorer: createOld } = await import(path.resolve(arg('old')));
  const oldCfg = { ...cfg, vision: { ...cfg.vision, clipImageRange: [0.62, 0.9] } };
  const old = createOld({ embedder, config: oldCfg, logger, product: { imageBuffer, title, attributes: {}, searchPlan: { queries: [title] } } });
  oldResults = await old(candidates);
  out.push(report('original scorer (CLIP whole image + colour)', oldResults));
}
const started = Date.now();
const scorer = createScorer({ embedder, config: cfg, logger, product: { imageBuffer, title, attributes: {}, searchPlan: plan } });
const results = await scorer(candidates);
out.push(report('new local relevance (no verifier)', results));
console.log(JSON.stringify({ title, scope: plan.scope, threshold, relevantLabels: relevant.join('+'), candidates: pool.length, newScorerSeconds: Math.round((Date.now() - started) / 100) / 10 }, null, 1));
console.table(out);
if (arg('dump')) fs.writeFileSync(arg('dump'), JSON.stringify(pool.map((e, i) => ({ ...e, score: results[i].score, status: results[i].matchStatus, local: results[i].detail.local, oldScore: oldResults?.[i]?.score ?? null, oldStatus: oldResults?.[i]?.matchStatus ?? null, evidence: results[i].detail.evidence, image: results[i].detail.image, text: results[i].detail.text })), null, 1));
