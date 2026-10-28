import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { captionMatches, classifyScore, combineLocal, createScorer, finalScore, mapCosine, parseVerdicts, textEvidence } from '../src/brain/score.js';
import { buildSearchPlan } from '../src/brain/plan.js';
import { colorHistogram, l2normalize } from '../src/brain/imageUtils.js';

test('cosine mapping is clamped to 0..1', () => {
  assert.equal(mapCosine(0.1, [0.6, 0.9]), 0);
  assert.equal(mapCosine(0.95, [0.6, 0.9]), 1);
  assert.ok(Math.abs(mapCosine(0.75, [0.6, 0.9]) - 0.5) < 1e-9);
});

test('local relevance combines image, CLIP text and caption evidence, and degrades without them', () => {
  assert.ok(Math.abs(combineLocal({ image: 1, text: 1, evidence: 1 }) - 1) < 1e-9);
  assert.ok(Math.abs(combineLocal({ image: 1, text: 0, evidence: 0 }) - 0.45) < 1e-9);
  assert.ok(Math.abs(combineLocal({ image: 1, text: null, evidence: 0 }) - 0.6) < 1e-9);
  assert.ok(Math.abs(combineLocal({ image: null, text: null, evidence: 1 }) - 0.75) < 1e-9);
  // Generic searches lean on "is it the product type" more than on similarity to one example photo.
  assert.ok(Math.abs(combineLocal({ image: 1, text: 0, evidence: 0, scope: 'category' }) - 0.2) < 1e-9);
  assert.ok(Math.abs(combineLocal({ image: 0, text: 0, evidence: 1, scope: 'category' }) - 0.45) < 1e-9);
});

test('final score is driven by the verifier verdict and stays within 0..100', () => {
  assert.equal(finalScore(0.5, null), 50);
  assert.equal(finalScore(0.4, { verdict: 'exact', confidence: 90 }, 'exact'), Math.round(0.75 * (55 + 40.5) + 10));
  assert.ok(finalScore(1, { verdict: 'different', confidence: 100 }, 'exact') <= 55);
  assert.equal(finalScore(null, null), null);
  for (const local of [0, 0.3, 1]) for (const confidence of [0, 50, 100]) for (const verdict of ['exact', 'different', 'same_category']) {
    const score = finalScore(local, { verdict, confidence }, 'exact');
    assert.ok(score >= 0 && score <= 100);
  }
});

test('threshold classification depends on the match scope', () => {
  assert.equal(classifyScore(55, 55), 'accepted');
  assert.equal(classifyScore(54, 55), 'low_match');
  assert.equal(classifyScore(null, 55), 'unscored');
  assert.equal(classifyScore(99, 55, 'different'), 'low_match');
  assert.equal(classifyScore(99, 55, 'unclear'), 'low_match');
  assert.equal(classifyScore(99, 55, 'same_category', 'exact'), 'low_match');
  assert.equal(classifyScore(99, 55, 'same_brand', 'exact'), 'low_match');
  assert.equal(classifyScore(70, 55, 'variant', 'exact'), 'accepted');
  assert.equal(classifyScore(70, 55, 'same_brand', 'brand'), 'accepted');
  assert.equal(classifyScore(70, 55, 'same_category', 'category'), 'accepted');
});

test('caption evidence finds brand, model and type, including compact hashtags and the account name', () => {
  const plan = buildSearchPlan({ title: 'Stanley Quencher H2.0 40 oz tumbler' });
  assert.deepEqual(textEvidence({ caption: 'Obsessed with my new cup #stanleyquencher' }, plan), { brand: true, model: true, type: false, score: 0.8 });
  assert.equal(textEvidence({ caption: 'morning routine', author: 'stanley_brand' }, plan).brand, true);
  assert.equal(textEvidence({ caption: 'pink kitchen appliance haul' }, plan).score, 0);
  assert.deepEqual(captionMatches('New Block Print tablecloth drop!', ['tablecloth', 'block print', 'red', 'in']), ['tablecloth', 'block print']);
});

test('verdict parsing accepts older field names and rejects malformed entries', () => {
  const parsed = parseVerdicts([{ candidate: 1, verdict: 'close', score: 80, reason: 'same cup, other colour' }, { candidate: 2, verdict: 'maybe', confidence: 50 }, { candidate: 9, verdict: 'exact', confidence: 99 }], 2);
  assert.deepEqual(parsed.get(0), { verdict: 'variant', confidence: 80, reason: 'same cup, other colour' });
  assert.equal(parsed.size, 1);
});

test('scorer ranks a near-identical thumbnail above an unrelated one and explains both', async () => {
  const productImage = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#fff"/><rect x="40" y="40" width="220" height="220" fill="#1d3b8a"/><circle cx="150" cy="150" r="60" fill="#f2f2f2"/></svg>')).jpeg().toBuffer();
  const similar = await sharp(productImage).resize(260).modulate({ brightness: 0.95 }).jpeg().toBuffer();
  const unrelated = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#e2a33c"/><rect x="0" y="200" width="300" height="100" fill="#3a7d2c"/></svg>')).jpeg().toBuffer();
  // Stub embedder: colour histogram as a vector, standing in for CLIP so the test needs no model download.
  const embedder = { embedImage: async (buffer) => ({ kind: 'clip', vector: l2normalize(await colorHistogram(buffer)) }), embedTexts: async () => null };
  const config = { frames: { enabled: false }, vision: { verifyWithVlm: false, matchThreshold: 55, clipImageRange: [0.3, 0.95] } };
  const title = 'Blue cushion cover';
  const scoreBatch = createScorer({ embedder, config, logger: console, product: { imageBuffer: productImage, title, attributes: {}, searchPlan: buildSearchPlan({ title }) } });

  const [good, bad, missing] = await scoreBatch([{ thumbnailBuffer: similar, caption: 'my new cushion cover' }, { thumbnailBuffer: unrelated, caption: 'holiday' }, { thumbnailBuffer: null }]);
  assert.ok(good.score > bad.score, `good ${good.score} vs bad ${bad.score}`);
  assert.equal(good.matchStatus, 'accepted');
  assert.equal(good.detail.verified, false, 'no verifier configured: marked unverified');
  assert.equal(bad.matchStatus, 'low_match');
  assert.equal(missing.matchStatus, 'unscored');
  assert.match(good.detail.reasons.at(-1), /^Score \d+ = local relevance \d+ \(not verified/);
});

test('query plan is built from the typed name: brand/model hashtags first, never colour or generic tags', () => {
  // Real failure: the CLIP fallback called a Stanley tumbler "kitchen appliance" and the old plan searched #pinkkitchenappliance.
  const plan = buildSearchPlan({ title: 'Stanley Quencher H2.0 40 oz tumbler', attributes: { productType: 'kitchen appliance', colors: ['pink'], material: 'plastic' } });
  assert.equal(plan.scope, 'exact');
  assert.equal(plan.productType, 'tumbler');
  assert.deepEqual(plan.hashtags.slice(0, 2), ['stanleyquencher', 'stanleytumbler']);
  assert.ok(plan.hashtags.every((tag) => !/pink|kitchen|appliance|plastic|large|text|logo/.test(tag)), plan.hashtags.join(','));
  assert.equal(plan.queries[0], 'Stanley Quencher');

  const generic = buildSearchPlan({ title: 'tumbler', attributes: { productType: 'mug', colors: ['grey'], printOrGraphic: 'large text logo' } });
  assert.equal(generic.scope, 'category');
  assert.deepEqual(generic.hashtags, ['tumbler', 'tumblers']);

  const gemini = buildSearchPlan({ title: 'Stanley Quencher H2.0 40 oz tumbler', fromVlm: true, attributes: { productType: 'tumbler' }, suggestions: { hashtags: ['stanleycup', 'pinkstanleytumblerwithhandle', 'hydration', 'drinkware'], instagramHandles: ['stanley_brand', 'random_cups'] } });
  assert.ok(gemini.hashtags.includes('stanleycup'));
  assert.ok(!gemini.hashtags.includes('hydration') && !gemini.hashtags.includes('drinkware') && !gemini.hashtags.includes('pinkstanleytumblerwithhandle'));
  assert.deepEqual(gemini.accounts, ['stanley_brand'], 'only handles that contain the brand name');
});
