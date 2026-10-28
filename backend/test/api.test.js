import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config as baseConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { openDatabase } from '../src/db/index.js';
import { createRepo } from '../src/db/repo.js';
import { createApp } from '../src/app.js';
import { createProgressHub } from '../src/pipeline/progress.js';
import { createJobQueue } from '../src/pipeline/jobQueue.js';
import { createSearchRunner } from '../src/pipeline/runSearch.js';
import { colorHistogram, l2normalize } from '../src/brain/imageUtils.js';
import { buildSearchPlan } from '../src/brain/analyze.js';
import { SourceError } from '../src/errors.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-test-'));
const config = {
  ...baseConfig,
  dataDir: tmp,
  dbPath: path.join(tmp, 'test.sqlite'),
  mediaDir: path.join(tmp, 'media'),
  demoMode: false,
  minPerSource: 8,
  maxRoundsPerSource: 4,
  vision: { ...baseConfig.vision, anthropicKey: '', backend: 'basic', matchThreshold: 40, clipImageRange: [0.3, 0.95] },
};

// Test doubles: a failing Instagram source and a synthetic Meta source (the demo generator).
let productImageForSources = null;
const failingInstagram = {
  platform: 'instagram',
  label: 'Instagram (stub)',
  isConfigured: () => true,
  createSession: () => ({ next: async () => { throw new SourceError('AUTH', 'apify-instagram: HTTP 401 invalid token'); } }),
};
// Deterministic synthetic Meta source: per page, 6 crops of the product photo (should match), 6 unrelated
// flat-colour images (should not), plus one repeated ID from the previous page and one re-encoded re-upload.
const metaSource = {
  platform: 'meta',
  label: 'Meta (synthetic test data)',
  isConfigured: () => true,
  createSession: ({ queries }) => {
    let page = 0;
    return {
      next: async () => {
        const items = [];
        for (let i = 0; i < 12; i += 1) {
          const id = `${queries[0]}-${page}-${i}`;
          const matching = i % 2 === 0;
          // Product plus a large scene panel (side and colour vary), so matching fixtures are distinct videos,
          // not near-copies of each other that dedup would rightly merge.
          const side = (i + page) % 4;
          const [x, y, w, h] = [[0, 0, 160, 400], [240, 0, 160, 400], [0, 0, 400, 160], [0, 240, 400, 160]][side];
          const panel = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="hsl(${(i * 47 + page * 89) % 360},65%,45%)"/></svg>`);
          const thumbnailBuffer = matching
            ? await sharp(productImageForSources).composite([{ input: panel }]).jpeg().toBuffer()
            : await sharp({ create: { width: 200, height: 360, channels: 3, background: { r: (i * 53 + page * 31) % 255, g: (i * 97) % 255, b: 40 } } }).jpeg().toBuffer();
          items.push({ platformId: `syn-${id}`, url: null, thumbnailBuffer, caption: `[TEST] ${matching ? 'match' : 'unrelated'} ${id}`, isDemo: true });
        }
        if (page > 0) items.push({ ...items[1], platformId: `syn-${queries[0]}-${page - 1}-1` });
        items.push({ ...items[2], platformId: `${items[2].platformId}-reupload`, thumbnailBuffer: await sharp(items[2].thumbnailBuffer).jpeg({ quality: 50 }).toBuffer() });
        page += 1;
        return { items, done: page >= 6, label: `test page ${page}` };
      },
    };
  },
};
const embedder = {
  method: async () => 'clip',
  fallbackReason: null,
  embedImage: async (buffer) => ({ kind: 'clip', vector: l2normalize(await colorHistogram(buffer)) }),
  embedTexts: async () => null,
};
const analyzeProduct = async ({ title }) => {
  const attributes = { productType: 'tablecloth', colors: ['navy'], printOrGraphic: 'block print', logos: [], textOnProduct: [] };
  return { attributes, searchPlan: buildSearchPlan(attributes, title), method: 'test-stub', warnings: [] };
};

let server;
let baseUrl;
let db;
let productPng;

before(async () => {
  productPng = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#fff"/><rect x="50" y="50" width="300" height="300" fill="#1d3b8a"/><circle cx="200" cy="200" r="80" fill="#e8d9b0"/></svg>')).png().toBuffer();
  productImageForSources = await sharp(productPng).jpeg().toBuffer();
  db = openDatabase(config.dbPath);
  const repo = createRepo(db);
  const progress = createProgressHub();
  const runSearch = createSearchRunner({ repo, sources: { instagram: failingInstagram, meta: metaSource }, analyzeProduct, embedder, progress, config, logger });
  const app = createApp({ repo, queue: createJobQueue({ concurrency: 1, logger }), runSearch, progress, config, logger, health: () => ({}) });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function startSearch(query, withImage = true) {
  const form = new FormData();
  form.set('query', query);
  if (withImage) form.set('image', new Blob([productPng], { type: 'image/png' }), 'product.png');
  const response = await fetch(`${baseUrl}/api/search`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

async function waitForSearch(id) {
  let latest;
  for (let i = 0; i < 600; i += 1) {
    latest = await (await fetch(`${baseUrl}/api/search/${id}`)).json();
    if (!['queued', 'running'].includes(latest.search.status)) return latest;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`search did not finish: ${JSON.stringify(latest?.search)}`);
}

test('rejects invalid input with structured errors', async () => {
  const empty = await fetch(`${baseUrl}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '' }) });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'BAD_REQUEST');

  const ssrf = await fetch(`${baseUrl}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'http://169.254.169.254/latest/meta-data' }) });
  assert.equal(ssrf.status, 400);
  assert.equal((await ssrf.json()).error.code, 'UNSAFE_URL');

  const form = new FormData();
  form.set('query', 'tablecloth');
  form.set('image', new Blob(['not an image'], { type: 'text/plain' }), 'notes.txt');
  const badUpload = await fetch(`${baseUrl}/api/search`, { method: 'POST', body: form });
  assert.equal(badUpload.status, 400);

  const missing = await fetch(`${baseUrl}/api/search/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');

  const unknownRoute = await fetch(`${baseUrl}/api/nope`);
  assert.equal(unknownRoute.status, 404);
});

let firstSearch;

test('one failing source does not break the search (partial success)', async () => {
  const { status, body } = await startSearch('indigo block print tablecloth');
  assert.equal(status, 202);
  firstSearch = await waitForSearch(body.id);

  assert.equal(firstSearch.search.status, 'partial');
  assert.equal(firstSearch.search.summary.instagram.status, 'failed');
  assert.match(firstSearch.search.summary.instagram.error, /401/);
  assert.ok(firstSearch.search.summary.meta.accepted >= config.minPerSource, `meta accepted ${firstSearch.search.summary.meta.accepted}`);
  assert.equal(firstSearch.results.instagram.length, 0);

  const keys = firstSearch.results.meta.map((v) => v.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate videos inside a result set');
  assert.ok(firstSearch.search.summary.meta.duplicates + firstSearch.search.summary.meta.nearDuplicates > 0, 'synthetic repeats were removed');
  for (const video of firstSearch.results.meta) {
    assert.ok(video.explanation?.reasons?.length, 'every result carries an explanation');
    assert.equal(video.isDemo, true);
  }
});

test('a repeat search returns new videos and keeps old ones behind previouslySeen', async () => {
  const { body } = await startSearch('indigo block print tablecloth');
  const second = await waitForSearch(body.id);

  const firstAccepted = new Set(firstSearch.results.meta.filter((v) => v.matchStatus === 'accepted' && !v.previouslySeen).map((v) => v.key));
  const secondNew = second.results.meta.filter((v) => v.matchStatus === 'accepted' && !v.previouslySeen);
  assert.ok(secondNew.length > 0, 'repeat search found new matches');
  for (const video of secondNew) assert.equal(firstAccepted.has(video.key), false, 'new results were not shown before');
  assert.ok(second.results.meta.some((v) => v.previouslySeen), 'previously seen videos are kept for the toggle');
  assert.ok(second.search.summary.meta.previouslySeen > 0);
});

test('history is persisted and survives reopening the database', async () => {
  const history = await (await fetch(`${baseUrl}/api/history`)).json();
  assert.ok(history.searches.length >= 2);
  assert.ok(history.searches.every((s) => s.id && s.status && s.createdAt));

  const reopened = createRepo(openDatabase(config.dbPath));
  const ids = reopened.listSearches(10).map((s) => s.id);
  assert.ok(ids.includes(firstSearch.search.id));
  reopened.db.close();
});

test('progress stream replays the final state for finished searches', async () => {
  const response = await fetch(`${baseUrl}/api/search/${firstSearch.search.id}/events`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  assert.match(text, /^data: /);
  assert.equal(JSON.parse(text.slice(6)).status, 'partial');
});
