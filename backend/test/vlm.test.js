import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createScorer } from '../src/brain/score.js';
import { buildSearchPlan } from '../src/brain/plan.js';
import { colorHistogram, l2normalize } from '../src/brain/imageUtils.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const img = (fill) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><rect x="30" y="30" width="140" height="140" fill="${fill}"/></svg>`)).jpeg().toBuffer();
const half = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><rect x="30" y="30" width="140" height="70" fill="#1d3b8a"/><rect x="30" y="100" width="140" height="70" fill="#c33"/></svg>')).jpeg().toBuffer();
// Stub embedder whose image similarity we control through the candidate image colour.
const embedder = { embedImage: async (b) => ({ kind: 'clip', vector: l2normalize(await colorHistogram(b)) }), embedTexts: async () => null };
const geminiReply = (verdicts, status = 200) => new Response(JSON.stringify(status === 200
  ? { candidates: [{ content: { parts: [{ text: JSON.stringify(verdicts) }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 } }
  : verdicts), { status, headers: { 'content-type': 'application/json' } });
const baseVision = { geminiKey: 'test-key', geminiModel: 'test-model', verifyWithVlm: true, vlmBatchSize: 6, matchThreshold: 55, clipImageRange: [0.3, 0.95], vlmSendFloor: 0.3, vlmMaxCallsPerSearch: 12 };
const scorerFor = async (vision, title = 'Acme blue cushion cover') => createScorer({
  embedder,
  config: { frames: { enabled: false }, vision: { ...baseVision, ...vision } },
  logger: { warn() {}, info() {} },
  product: { imageBuffer: await img('#1d3b8a'), title, attributes: { distinctiveFeatures: ['blue square'] }, searchPlan: buildSearchPlan({ title }) },
});
const imagesIn = (init) => JSON.parse(init.body).contents[0].parts.filter((p) => p.inline_data).length;

test('candidates are verified best-first in one batched Gemini call; low-relevance ones are not sent', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), images: imagesIn(init), prompt: JSON.parse(init.body).contents[0].parts.at(-1).text });
    return geminiReply([{ candidate: 1, verdict: 'exact', confidence: 92, reason: 'same blue square cover' }, { candidate: 2, verdict: 'different', confidence: 90, reason: 'two-colour print' }]);
  };
  const scorer = await scorerFor({});
  const [unrelated, identical, partial] = await scorer([{ thumbnailBuffer: await img('#2c9c3c') }, { thumbnailBuffer: await img('#1d3b8a'), caption: 'Acme cushion cover' }, { thumbnailBuffer: await half() }]);

  assert.equal(calls.length, 1, 'one batched call');
  assert.equal(calls[0].images, 3, 'reference + the two candidates above the send floor');
  assert.match(calls[0].prompt, /There are 2 candidates/);
  assert.equal(identical.detail.vlm.verdict, 'exact');
  assert.equal(identical.matchStatus, 'accepted');
  assert.equal(identical.detail.verified, true);
  assert.match(identical.detail.reasons.at(-1), /^Score \d+ = 0\.75 × Gemini \d+ \+ 0\.25 × local \d+$/);
  assert.equal(partial.detail.vlm.verdict, 'different');
  assert.equal(partial.matchStatus, 'low_match');
  assert.match(unrelated.detail.vlmSkipped, /below 30/);
  assert.equal(unrelated.matchStatus, 'low_match');
  assert.deepEqual({ calls: scorer.usage.vlmCalls, input: scorer.usage.vlmInputTokens, output: scorer.usage.vlmOutputTokens }, { calls: 1, input: 1200, output: 80 });
});

test('verification stops as soon as enough matches are confirmed, saving free quota', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return geminiReply([{ candidate: 1, verdict: 'exact', confidence: 90, reason: 'same item' }]);
  };
  const scorer = await scorerFor({ vlmBatchSize: 1 });
  const results = await scorer(await Promise.all([1, 2, 3, 4].map(async () => ({ thumbnailBuffer: await img('#1d3b8a') }))), { need: 2 });
  assert.equal(calls, 2);
  assert.equal(results.filter((r) => r.matchStatus === 'accepted').length, 2);
  assert.ok(results.slice(2).every((r) => /enough confirmed matches/.test(r.detail.vlmSkipped)));
});

test('a high confidence cannot turn a rejected verdict into a match; scope decides what counts', async () => {
  globalThis.fetch = async () => geminiReply([{ candidate: 1, verdict: 'same_category', confidence: 100, reason: 'another brand of cushion cover' }]);
  const exact = await scorerFor({}, 'Acme Lumo cushion cover');
  const [rejected] = await exact([{ thumbnailBuffer: await img('#1d3b8a') }]);
  assert.equal(rejected.matchStatus, 'low_match');
  assert.ok(rejected.detail.reasons.some((r) => /^Rejected: a "Same category" verdict does not count/.test(r)));

  const category = await scorerFor({}, 'cushion cover');
  const [kept] = await category([{ thumbnailBuffer: await img('#1d3b8a') }]);
  assert.equal(kept.matchStatus, 'accepted', 'a generic search accepts the product category');
});

test('Gemini quota exhaustion disables verification for the rest of the search and keeps local scores', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return geminiReply({ error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota; check billing details.' } }, 429);
  };
  const scorer = await scorerFor({ vlmBatchSize: 1 });
  const results = await scorer(await Promise.all([1, 2, 3].map(async () => ({ thumbnailBuffer: await img('#1d3b8a'), caption: 'Acme cushion cover' }))));
  assert.equal(calls, 1, 'no repeat Gemini calls after a definitive quota error');
  assert.ok(results.every((result) => result.score !== null));
  assert.match(results[0].detail.vlmSkipped, /Verification failed \(.*quota is exhausted/);
  assert.match(results[1].detail.vlmSkipped, /Not verified: verifier unavailable/);
  assert.ok(results.every((r) => r.detail.verified === false));
  assert.equal(results[1].matchStatus, 'accepted', 'strong local + caption evidence is still accepted, flagged as unverified');
});

test('a failed verifier call keeps the local score and records why', async () => {
  globalThis.fetch = async () => geminiReply({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
  const scorer = await scorerFor({ geminiEndpoint: 'aistudio' });
  const [result] = await scorer([{ thumbnailBuffer: await img('#1d3b8a') }]);
  assert.ok(result.score > 0);
  assert.match(result.detail.vlmSkipped, /Verification failed \(.*rejected the API key/);
});

test('videos already shown in earlier searches are not sent to the verifier', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return geminiReply([]);
  };
  const scorer = await scorerFor({});
  const [seen] = await scorer([{ thumbnailBuffer: await img('#1d3b8a'), skipVerify: true }]);
  assert.equal(calls, 0);
  assert.match(seen.detail.vlmSkipped, /earlier search/);
});
