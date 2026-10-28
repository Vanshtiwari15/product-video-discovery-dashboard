import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pickField, runActor, getActorInputSchema } from '../src/sources/apify.js';
import { buildInstagramInput, createInstagramSource, normalizeInstagramItem } from '../src/sources/instagram.js';
import { buildMetaInput, createMetaSource, normalizeMetaAdItem } from '../src/sources/meta.js';

// Local fake of the Apify REST endpoints the adapter uses. No paid calls.
let server;
let base;
const state = { runs: new Map(), aborted: [], startQuery: null, startBody: null, failStarts: new Map(), starts: [], malformedDatasets: new Set() };
const scenarios = {
  ok: { finalStatus: 'SUCCEEDED', items: [{ id: '1' }, { id: '2' }] },
  'instagram-success': { finalStatus: 'SUCCEEDED', items: [{ id: 'ig-1', type: 'Video', shortCode: 'ReelOne', videoUrl: 'https://cdn.example/reel.mp4', displayUrl: 'https://cdn.example/reel.jpg', ownerUsername: 'cupshop' }] },
  'instagram-empty': { finalStatus: 'SUCCEEDED', items: [] },
  'brand-reels': { finalStatus: 'SUCCEEDED', items: [{ id: 'ig-brand-1', type: 'Video', shortCode: 'BrandReel', videoUrl: 'https://cdn.example/brand.mp4', displayUrl: 'https://cdn.example/brand.jpg', ownerUsername: 'stanley_brand' }] },
  'meta-success': { finalStatus: 'SUCCEEDED', items: [{ adArchiveID: 'ad-1', pageName: 'Cup Shop', snapshot: { videos: [{ video_preview_image_url: 'https://cdn.example/ad.jpg', video_hd_url: 'https://cdn.example/ad.mp4' }] } }] },
  'meta-empty': { finalStatus: 'SUCCEEDED', items: [] },
  'timeout-partial': { finalStatus: 'TIMED-OUT', items: [{ id: '3' }] },
  'timeout-empty': { finalStatus: 'TIMED-OUT', items: [] },
  slow: { finalStatus: null, items: [] },
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const actor = url.pathname.match(/^\/acts\/([^/]+)\/runs$/);
      if (actor && req.method === 'POST') {
        state.startQuery = Object.fromEntries(url.searchParams);
        state.startBody = JSON.parse(body);
        const actorId = decodeURIComponent(actor[1]);
        state.starts.push({ actorId, query: state.startQuery, body: state.startBody });
        const failuresLeft = state.failStarts.get(actorId) || 0;
        if (failuresLeft > 0) {
          state.failStarts.set(actorId, failuresLeft - 1);
          return send(503, { error: { message: 'temporary actor API failure' } });
        }
        const id = `run-${actorId}`;
        state.runs.set(id, { polls: 0, scenario: scenarios[actorId] || scenarios.ok });
        return send(201, { data: { id, status: 'RUNNING', defaultDatasetId: `ds-${id}` } });
      }
      const poll = url.pathname.match(/^\/actor-runs\/([^/]+)$/);
      if (poll) {
        const run = state.runs.get(poll[1]);
        run.polls += 1;
        const status = run.scenario.finalStatus && run.polls >= 2 ? run.scenario.finalStatus : 'RUNNING';
        if (!run.scenario.finalStatus) return setTimeout(() => send(200, { data: { id: poll[1], status, defaultDatasetId: `ds-${poll[1]}` } }), 200);
        return send(200, { data: { id: poll[1], status, defaultDatasetId: `ds-${poll[1]}`, usageTotalUsd: 0.0123 } });
      }
      const abort = url.pathname.match(/^\/actor-runs\/([^/]+)\/abort$/);
      if (abort) {
        state.aborted.push(abort[1]);
        return send(200, { data: { status: 'ABORTED' } });
      }
      const dataset = url.pathname.match(/^\/datasets\/ds-([^/]+)\/items$/);
      if (dataset) {
        if (state.malformedDatasets.has(dataset[1])) return send(200, { error: 'dataset unavailable' });
        return send(200, state.runs.get(dataset[1]).scenario.items);
      }
      if (url.pathname === '/acts/with-schema') return send(200, { data: { taggedBuilds: { latest: { buildId: 'b1' } } } });
      if (url.pathname === '/actor-builds/b1') return send(200, { data: { inputSchema: JSON.stringify({ properties: { hashtags: {}, resultsLimit: {}, resultsType: { enum: ['posts', 'reels'] } } }) } });
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const cfg = () => ({ dataDir: '/tmp', apify: { token: 't', baseUrl: base, runTimeoutSecs: 30, dumpRaw: false } });

test('successful run: polls to completion, reads the dataset, reports usage and passes maxItems', async () => {
  const { items, run } = await runActor('ok', { hashtags: ['x'] }, { config: cfg(), label: 'test', maxItems: 25 });
  assert.deepEqual(items.map((i) => i.id), ['1', '2']);
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.usageUsd, 0.0123);
  assert.equal(state.startQuery.maxItems, '25');
  assert.deepEqual(state.startBody, { hashtags: ['x'] });
});

test('a timed-out run keeps its partial results; an empty timed-out run is a retryable error', async () => {
  const partial = await runActor('timeout-partial', {}, { config: cfg(), label: 'test' });
  assert.equal(partial.items.length, 1);
  assert.equal(partial.run.status, 'TIMED-OUT');
  await assert.rejects(runActor('timeout-empty', {}, { config: cfg(), label: 'test' }), (e) => e.code === 'RUN_TIMED_OUT' && e.retryable === true);
});

test('a successful actor with an empty dataset is distinct from malformed dataset output', async () => {
  scenarios['empty-success'] = { finalStatus: 'SUCCEEDED', items: [] };
  const empty = await runActor('empty-success', {}, { config: cfg(), label: 'test' });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.run.status, 'SUCCEEDED');

  state.malformedDatasets.add('run-malformed-data');
  await assert.rejects(runActor('malformed-data', {}, { config: cfg(), label: 'test' }), (error) => error.code === 'BAD_RESPONSE');
  state.malformedDatasets.delete('run-malformed-data');
});

test('our source timeout aborts the Apify run so it stops billing', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(runActor('slow', {}, { config: cfg(), label: 'test', signal: controller.signal }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(state.aborted.includes('run-slow'));
});

test('a source timeout racing run creation still aborts the new Apify run', async () => {
  const controller = new AbortController();
  const realFetch = globalThis.fetch;
  const abortedBefore = state.aborted.length;
  globalThis.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).includes('/acts/race-abort/runs')) controller.abort(new Error('source timed out'));
    return response;
  };
  try {
    await assert.rejects(runActor('race-abort', {}, { config: cfg(), label: 'test', signal: controller.signal }));
  } finally {
    globalThis.fetch = realFetch;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(state.aborted.slice(abortedBefore).includes('run-race-abort'));
});

test('input field names follow the live actor schema', async () => {
  const schema = await getActorInputSchema('with-schema', { config: cfg() });
  assert.deepEqual(buildInstagramInput(schema, ['a'], 10), { hashtags: ['a'], resultsLimit: 10, resultsType: 'reels' });
  assert.deepEqual(buildInstagramInput({ properties: { hashtags: {}, maxItems: {} } }, ['a'], 10), { hashtags: ['a'], maxItems: 10 });
  assert.deepEqual(buildMetaInput({ properties: { urls: {}, count: {} } }, 'https://u', 5), { urls: [{ url: 'https://u' }], count: 5 });
  assert.deepEqual(buildMetaInput(null, 'https://u', 5), { startUrls: [{ url: 'https://u' }], resultsLimit: 5 });
  assert.equal(pickField({ properties: {} }, ['a', 'b']), null);
});

test('retryable Apify errors retry the same Instagram hashtag batch and Meta query', async () => {
  const config = {
    ...cfg(),
    apify: { ...cfg().apify, instagramActor: 'cursor-instagram', metaActor: 'cursor-meta', hashtagsPerRun: 3, metaQueriesPerRound: 1 },
    meta: { provider: 'apify', countries: ['US'] },
  };
  const logger = { warn() {}, error() {} };
  const instagram = createInstagramSource({ config, logger });
  const instagramSession = instagram.createSession({ hashtags: ['firsttag', 'secondtag', 'thirdtag'], queries: [], signal: new AbortController().signal });
  state.failStarts.set('cursor-instagram', 2);
  const instagramStartsAt = state.starts.length;
  await assert.rejects(instagramSession.next(20), (error) => error.retryable === true);
  await instagramSession.next(20);
  const instagramStarts = state.starts.slice(instagramStartsAt).filter((entry) => entry.actorId === 'cursor-instagram');
  assert.equal(instagramStarts.length, 3, 'two HTTP attempts fail, then the next session call succeeds');
  assert.deepEqual(instagramStarts.map((entry) => entry.body.hashtags), [
    ['firsttag', 'secondtag', 'thirdtag'],
    ['firsttag', 'secondtag', 'thirdtag'],
    ['firsttag', 'secondtag', 'thirdtag'],
  ]);

  const meta = createMetaSource({ config, logger });
  const metaSession = meta.createSession({ queries: ['first product query', 'second product query'], signal: new AbortController().signal });
  state.failStarts.set('cursor-meta', 2);
  const metaStartsAt = state.starts.length;
  await assert.rejects(metaSession.next(20), (error) => error.retryable === true);
  await metaSession.next(20);
  const metaStarts = state.starts.slice(metaStartsAt).filter((entry) => entry.actorId === 'cursor-meta');
  assert.equal(metaStarts.length, 3);
  assert.deepEqual(metaStarts.map((entry) => new URL(entry.body.startUrls[0].url).searchParams.get('q')), [
    'first product query',
    'first product query',
    'first product query',
  ]);
});

test('Instagram source returns valid Reel metadata and distinguishes an empty successful result', async () => {
  const config = { ...cfg(), apify: { ...cfg().apify, instagramActor: 'instagram-success' } };
  const source = createInstagramSource({ config, logger: { warn() {} } });
  const session = source.createSession({ hashtags: ['stanleyquencher'], queries: [], signal: new AbortController().signal });
  const page = await session.next(20);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].url, 'https://www.instagram.com/reel/ReelOne/');
  assert.equal(page.items[0].videoUrl, 'https://cdn.example/reel.mp4');
  assert.equal(page.items[0].author, 'cupshop');

  const emptySource = createInstagramSource({ config: { ...config, apify: { ...config.apify, instagramActor: 'instagram-empty' } }, logger: { warn() {} } });
  const empty = await emptySource.createSession({ hashtags: ['stanleyquencher'], queries: [], signal: new AbortController().signal }).next(20);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.warnings, []);
});

test('Meta source returns video ad links and distinguishes a legitimate empty result', async () => {
  const config = { ...cfg(), apify: { ...cfg().apify, metaActor: 'meta-success' }, meta: { provider: 'apify', countries: ['ALL'] } };
  const source = createMetaSource({ config, logger: { warn() {} } });
  const page = await source.createSession({ queries: ['Stanley tumbler'], signal: new AbortController().signal }).next(20);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].url, 'https://www.facebook.com/ads/library/?id=ad-1');
  assert.equal(page.items[0].videoUrl, 'https://cdn.example/ad.mp4');
  assert.equal(page.items[0].author, 'Cup Shop');

  const emptySource = createMetaSource({ config: { ...config, apify: { ...config.apify, metaActor: 'meta-empty' } }, logger: { warn() {} } });
  const empty = await emptySource.createSession({ queries: ['Stanley tumbler'], signal: new AbortController().signal }).next(20);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.warnings, []);
});

test('Meta Graph pagination retries failed pages without skipping queries', async () => {
  const realFetch = globalThis.fetch;
  const requested = [];
  const pages = [
    { data: [], paging: { next: 'https://graph.example/cursor-page-2' } },
    { data: [] },
    { data: [] },
  ];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify(pages.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const source = createMetaSource({
      config: { meta: { provider: 'graph', graphToken: 'test-token', graphVersion: 'v23.0', countries: ['US'] }, requestRetries: 0 },
      logger: { warn() {} },
    });
    const session = source.createSession({ queries: ['first query', 'second query'], signal: new AbortController().signal });
    await session.next(20);
    await session.next(20);
    await session.next(20);
    assert.equal(requested.length, 3);
    assert.equal(new URL(requested[0]).searchParams.get('search_terms'), 'first query');
    assert.equal(requested[1], 'https://graph.example/cursor-page-2');
    assert.equal(new URL(requested[2]).searchParams.get('search_terms'), 'second query');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Meta Graph authentication errors remain failures rather than empty ad results', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Access denied' } }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const source = createMetaSource({
      config: { meta: { provider: 'graph', graphToken: 'test-token', graphVersion: 'v23.0', countries: ['US'] }, requestRetries: 0 },
      logger: { warn() {} },
    });
    const session = source.createSession({ queries: ['Stanley tumbler'], signal: new AbortController().signal });
    await assert.rejects(session.next(20), (error) => error.code === 'AUTH' && /Access denied/.test(error.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Shapes below follow the actors' documented output. They are NOT live responses: run
// `npm run verify:sources -- --probe --yes` to check real field coverage.
test('normalisers accept documented Instagram and Meta item shapes and reject non-video items', () => {
  const reel = normalizeInstagramItem({ id: '311', shortCode: 'C1abc', type: 'Video', productType: 'clips', caption: 'tee', displayUrl: 'https://cdn/x.jpg', videoUrl: 'https://cdn/x.mp4', ownerUsername: 'shop', timestamp: '2026-09-01T10:00:00.000Z', likesCount: 4 });
  assert.equal(reel.url, 'https://www.instagram.com/reel/C1abc/');
  assert.equal(reel.platformId, '311');
  assert.equal(normalizeInstagramItem({ id: '1', type: 'Image', displayUrl: 'x' }), null);

  const camel = normalizeMetaAdItem({ adArchiveID: '99', pageName: 'Brand', startDate: 1756000000, collationID: 'c1', snapshot: { body: { text: 'Buy now' }, videos: [{ videoPreviewImageUrl: 'https://cdn/p.jpg', videoHdUrl: 'https://cdn/v.mp4' }] } });
  const snake = normalizeMetaAdItem({ ad_archive_id: '98', page_name: 'Brand', start_date: '2026-08-01', snapshot: { cards: [{ body: 'Card copy', video_preview_image_url: 'https://cdn/p2.jpg', video_sd_url: 'https://cdn/v2.mp4' }] } });
  assert.equal(camel.url, 'https://www.facebook.com/ads/library/?id=99');
  assert.equal(camel.thumbnailUrl, 'https://cdn/p.jpg');
  assert.equal(camel.extra.collationId, 'c1');
  assert.equal(snake.caption, 'Card copy');
  assert.equal(snake.videoUrl, 'https://cdn/v2.mp4');
  assert.equal(normalizeMetaAdItem({ adArchiveID: '1', snapshot: { images: [{}] } }), null, 'image-only ads are not video ads');
});

test('Instagram adds the brand account Reels in parallel on the first round only, and survives that run failing', async () => {
  const config = { ...cfg(), apify: { ...cfg().apify, instagramActor: 'instagram-success', instagramReelActor: 'brand-reels', instagramBrandReels: true, hashtagsPerRun: 1 } };
  const source = createInstagramSource({ config, logger: { warn() {} } });
  const startsAt = state.starts.length;
  const session = source.createSession({ hashtags: ['stanleyquencher', 'stanleytumbler'], accounts: ['stanley_brand'], signal: new AbortController().signal });
  const first = await session.next(20);
  assert.equal(first.items.length, 2);
  assert.ok(first.items.some((item) => item.author === 'stanley_brand' && item.foundBy === '@stanley_brand'));
  assert.equal(first.runs.length, 2);
  assert.match(first.label, /#stanleyquencher \+ @stanley_brand reels/);
  const second = await session.next(20);
  assert.equal(second.label, '#stanleytumbler');
  assert.equal(second.done, true);
  const starts = state.starts.slice(startsAt);
  assert.deepEqual(starts.filter((s) => s.actorId === 'brand-reels').map((s) => s.body.username), [['stanley_brand']]);

  const failing = createInstagramSource({ config: { ...config, apify: { ...config.apify, instagramReelActor: 'missing-actor-401' } }, logger: { warn() {} } });
  state.failStarts.set('missing-actor-401', 5);
  const page = await failing.createSession({ hashtags: ['stanleyquencher'], accounts: ['stanley_brand'], signal: new AbortController().signal }).next(20);
  assert.equal(page.items.length, 1, 'hashtag results are kept');
  assert.ok(page.warnings.some((w) => /brand Reels \(@stanley_brand\) failed/.test(w)));
  state.failStarts.delete('missing-actor-401');
});

test('Meta runs two queries per round in parallel and labels where each ad came from', async () => {
  const config = { ...cfg(), apify: { ...cfg().apify, metaActor: 'meta-success', metaQueriesPerRound: 2 }, meta: { provider: 'apify', countries: ['ALL'] } };
  const startsAt = state.starts.length;
  const page = await createMetaSource({ config, logger: { warn() {} } }).createSession({ queries: ['Stanley Quencher', 'Stanley tumbler', 'Stanley'], signal: new AbortController().signal }).next(20);
  const queries = state.starts.slice(startsAt).map((s) => new URL(s.body.startUrls[0].url).searchParams.get('q'));
  assert.deepEqual(queries.sort(), ['Stanley Quencher', 'Stanley tumbler']);
  assert.equal(page.label, '"Stanley Quencher" + "Stanley tumbler"');
  assert.equal(page.done, false);
  assert.equal(page.runs.length, 2);
});
