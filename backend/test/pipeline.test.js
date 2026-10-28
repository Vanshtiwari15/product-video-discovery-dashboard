import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { requestJson } from '../src/http/apiClient.js';
import { withRetry } from '../src/http/retry.js';
import { collectFromSource } from '../src/pipeline/collect.js';
import { createDedupState } from '../src/pipeline/dedup.js';
import { openDatabase } from '../src/db/index.js';
import { createRepo } from '../src/db/repo.js';
import { createProductAnalyzer } from '../src/brain/analyze.js';
import { SourceError } from '../src/errors.js';

let server;
let base;
const hits = {};
before(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const n = hits[req.url];
    if (req.url === '/flaky' && n < 3) return res.writeHead(503).end('{}');
    if (req.url === '/limited' && n < 2) return res.writeHead(429, { 'retry-after': '1' }).end('{}');
    if (req.url === '/auth') return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"bad token"}}');
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 600);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('retries 5xx with backoff and succeeds', async () => {
  assert.deepEqual(await requestJson(`${base}/flaky`, { retries: 2 }), { ok: true });
  assert.equal(hits['/flaky'], 3);
});

test('honours Retry-After on 429', async () => {
  const started = Date.now();
  await requestJson(`${base}/limited`, { retries: 1 });
  assert.ok(Date.now() - started >= 900, 'waited about one second');
});

test('does not retry auth errors and reports them clearly', async () => {
  await assert.rejects(requestJson(`${base}/auth`, { retries: 3, label: 'apify' }), (e) => e.code === 'AUTH' && /HTTP 401 bad token/.test(e.message));
  assert.equal(hits['/auth'], 1);
});

test('times out slow requests and retries them', async () => {
  await assert.rejects(requestJson(`${base}/slow`, { retries: 1, timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
  assert.equal(hits['/slow'], 2);
});

test('withRetry gives up immediately on non-retryable errors', async () => {
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts += 1; throw new SourceError('BAD', 'no'); }, { retries: 3 }));
  assert.equal(attempts, 1);
});

// Near-duplicate matching is disabled here (nearDistance -1): solid test images share one perceptual hash.
// Top-up: the collector keeps requesting rounds until enough new matches pass, and stops when the plan runs out.
function stubSource(rounds) {
  return {
    platform: 'meta',
    createSession: () => {
      let i = 0;
      return { next: async () => ({ items: rounds[i] ?? [], done: ++i >= rounds.length, label: `round ${i}` }) };
    },
  };
}
const item = async (id, good) => ({
  platformId: id,
  thumbnailBuffer: await sharp({ create: { width: 40 + Number(id.replace(/\D/g, '')), height: 60, channels: 3, background: good ? '#1d3b8a' : { r: (Number(id.replace(/\D/g, '')) * 37) % 255, g: 200, b: 20 } } }).jpeg().toBuffer(),
  caption: id,
});

test('top-up: keeps fetching until the target is met, skipping duplicates and low matches', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-topup-'));
  const repo = createRepo(openDatabase(path.join(tmp, 'db.sqlite')));
  repo.createSearch({ id: 's1', inputType: 'keyword', inputText: 'x', hasUpload: false, isDemo: true });
  const rounds = [
    [await item('a1', false), await item('a2', false), await item('a3', true)],
    [await item('a3', true), await item('b1', true), await item('b2', false)],
    [await item('c1', true), await item('c2', true)],
    [await item('d1', true)],
  ];
  // Score is 90 for the blue "good" thumbnails, 10 otherwise.
  const scoreBatch = async (cands) => Promise.all(cands.map(async (c) => {
    const { dominant } = await sharp(c.thumbnailBuffer).stats();
    const good = dominant.b > 100;
    return { score: good ? 90 : 10, matchStatus: good ? 'accepted' : 'low_match', detail: { reasons: ['stub'] } };
  }));
  const config = { minPerSource: 4, maxRoundsPerSource: 6, mediaDir: path.join(tmp, 'media') };
  const stats = await collectFromSource({ source: stubSource(rounds), searchPlan: { queries: [], hashtags: [] }, searchId: 's1', dedup: createDedupState({ nearDistance: -1 }), scoreBatch, repo, config, signal: new AbortController().signal, onProgress: () => {} });

  assert.equal(stats.rounds, 3, 'stopped once 4 new matches were found');
  assert.equal(stats.accepted, 4);
  assert.equal(stats.duplicates, 1, 'a3 repeated in round 2');
  assert.equal(stats.lowMatch, 3);
  assert.equal(stats.status, 'ok');
  assert.equal(repo.loadSeen().length, 4, 'only accepted videos are marked as seen');

  repo.createSearch({ id: 's2', inputType: 'keyword', inputText: 'x', hasUpload: false, isDemo: true });
  const short = await collectFromSource({ source: stubSource(rounds.slice(0, 1)), searchPlan: { queries: [], hashtags: [] }, searchId: 's2', dedup: createDedupState({ seen: repo.loadSeen(), nearDistance: -1 }), scoreBatch, repo, config, signal: new AbortController().signal, onProgress: () => {} });
  assert.equal(short.status, 'short', 'plan exhausted below target is reported as a shortfall');
  assert.equal(short.previouslySeen, 1, 'a3 from the first search is flagged as previously seen');
  repo.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a later source abort preserves accepted matches and reports the shortfall', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-abort-count-'));
  const repo = createRepo(openDatabase(path.join(tmp, 'db.sqlite')));
  repo.createSearch({ id: 's1', inputType: 'keyword', inputText: 'x', hasUpload: false, isDemo: true });
  let page = 0;
  const source = {
    platform: 'meta',
    label: 'Meta test source',
    createSession: () => ({
      next: async () => {
        if (page++ === 0) return { items: [await item('kept1', true)], done: false, label: 'first page' };
        throw new SourceError('ABORTED', 'provider request aborted');
      },
    }),
  };
  const scoreBatch = async (candidates) => candidates.map(() => ({ score: 90, matchStatus: 'accepted', detail: { reasons: ['stub match'] } }));
  const stats = await collectFromSource({
    source,
    searchPlan: { queries: [], hashtags: [] },
    searchId: 's1',
    dedup: createDedupState({ nearDistance: -1 }),
    scoreBatch,
    repo,
    config: { minPerSource: 2, maxRoundsPerSource: 6, mediaDir: path.join(tmp, 'media') },
    signal: new AbortController().signal,
    onProgress: () => {},
  });

  assert.equal(stats.accepted, 1);
  assert.equal(stats.status, 'short');
  assert.equal(stats.errorCode, 'ABORTED');
  assert.match(stats.error, /provider request aborted/);
  assert.equal(repo.getSearchVideos('s1').filter((video) => video.match_status === 'accepted').length, 1);
  repo.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('product analysis and product pages are cached', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-cache-'));
  const repo = createRepo(openDatabase(path.join(tmp, 'db.sqlite')));
  let embedCalls = 0;
  const embedder = { method: async () => 'basic', fallbackReason: null, embedImage: async () => { embedCalls += 1; return { kind: 'basic', vector: new Float32Array(4) }; }, embedTexts: async () => null };
  const analyze = createProductAnalyzer({ embedder, repo, config: { vision: { anthropicKey: '', backend: 'basic' } }, logger: { warn() {} } });
  const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const first = await analyze({ title: 'Blue tee', imageBuffer: image, imageHash: 'h1' });
  const second = await analyze({ title: 'Blue tee', imageBuffer: image, imageHash: 'h1' });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.searchPlan, first.searchPlan);

  repo.cachePage('u1', 'https://x', { title: 'T' });
  assert.deepEqual(repo.getCachedPage('u1', 24), { title: 'T' });
  assert.equal(repo.getCachedPage('u1', -1), null, 'expired entries are ignored');
  repo.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Gemini quota failure uses an explicit fallback and short-lived analysis cache', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-gemini-quota-'));
  const repo = createRepo(openDatabase(path.join(tmp, 'db.sqlite')));
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota; check billing.' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  };
  const embedder = {
    method: async () => 'basic',
    fallbackReason: null,
    embedImage: async () => ({ kind: 'basic', vector: new Float32Array(4) }),
    embedTexts: async () => null,
  };
  const analyze = createProductAnalyzer({
    embedder,
    repo,
    config: { analysisFailureCacheMs: 300_000, vision: { geminiKey: 'test-key', geminiModel: 'test-model', backend: 'basic' } },
    logger: { warn() {} },
  });
  const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  try {
    const first = await analyze({ title: 'Blue mug', imageBuffer: image, imageHash: 'quota-image' });
    const second = await analyze({ title: 'Blue mug', imageBuffer: image, imageHash: 'quota-image' });
    assert.equal(first.status, 'partial');
    assert.equal(first.providerFailure.code, 'GEMINI_QUOTA_EXHAUSTED');
    assert.match(first.warnings.join(' '), /Check Gemini project quota and billing/);
    assert.equal(second.cached, true);
    assert.equal(calls, 1, 'cached fallback avoids repeated quota-consuming analysis calls');
  } finally {
    globalThis.fetch = realFetch;
    repo.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Gemini analysis timeout returns fallback attributes and an actionable partial warning', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-gemini-timeout-'));
  const repo = createRepo(openDatabase(path.join(tmp, 'db.sqlite')));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'TimeoutError')), { once: true });
    setTimeout(() => reject(new Error('mock transport did not complete')), 100);
  });
  const embedder = {
    method: async () => 'basic',
    fallbackReason: null,
    embedImage: async () => ({ kind: 'basic', vector: new Float32Array(4) }),
    embedTexts: async () => null,
  };
  const analyze = createProductAnalyzer({
    embedder,
    repo,
    config: { analysisFailureCacheMs: 300_000, vision: { geminiKey: 'test-key', geminiModel: 'test-model', geminiTimeoutMs: 15, geminiRetries: 0, backend: 'basic' } },
    logger: { warn() {} },
  });
  const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  try {
    const result = await analyze({ title: 'Blue mug', imageBuffer: image, imageHash: 'timeout-image' });
    assert.equal(result.status, 'partial');
    assert.equal(result.method, 'pixel-colours');
    assert.equal(result.providerFailure.code, 'GEMINI_TIMEOUT');
    assert.match(result.warnings.join(' '), /check network latency and provider status/);
  } finally {
    globalThis.fetch = realFetch;
    repo.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a shortfall is explained from recorded counts and never padded', async () => {
  const { explainShortfall } = await import('../src/pipeline/runSearch.js');
  const stats = { accepted: 7, fetched: 160, duplicates: 4, nearDuplicates: 30, previouslySeen: 2, lowMatch: 117, error: null, warnings: [], status: 'short' };
  const text = explainShortfall('Meta', stats, 20);
  assert.match(text, /^Meta: 7\/20 relevant videos\. 160 candidates fetched \(34 duplicates, 2 shown in earlier searches, 117 not relevant or not confirmed\)\./);
  assert.match(text, /Every planned query\/hashtag was tried/);
  assert.match(text, /not padded/);
  assert.equal(explainShortfall('Meta', { ...stats, accepted: 20 }, 20), null);
  assert.match(explainShortfall('Meta', { ...stats, warnings: ['Meta: stopped at the free-tier budget of 450 provider items'] }, 20), /free tier/);
});
