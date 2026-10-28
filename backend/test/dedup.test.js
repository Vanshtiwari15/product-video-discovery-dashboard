import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { contentKey, createDedupState, normalizeVideoUrl, videoKey } from '../src/pipeline/dedup.js';
import { fingerprint, hammingDistance, isNearDuplicate } from '../src/brain/imageUtils.js';

test('video keys prefer platform IDs and fall back to a normalised URL hash', () => {
  assert.equal(videoKey({ platform: 'instagram', platformId: '123' }), 'instagram:123');
  const a = videoKey({ platform: 'instagram', url: 'https://www.instagram.com/reel/ABC/?utm_source=x' });
  const b = videoKey({ platform: 'instagram', url: 'https://instagram.com/p/ABC' });
  assert.equal(a, b);
  assert.match(videoKey({ platform: 'meta', platformId: '9', isDemo: true }), /^demo:meta:/);
  assert.equal(normalizeVideoUrl('https://www.facebook.com/ads/library/?id=42&foo=1'), 'facebook.com/ads/library?id=42');
});

test('exact duplicates inside one search are removed', () => {
  const state = createDedupState({});
  assert.equal(state.checkIdentity({ platform: 'instagram', videoKey: 'instagram:1' }), 'new');
  assert.equal(state.checkIdentity({ platform: 'instagram', videoKey: 'instagram:1' }), 'duplicate');
});

test('videos shown by earlier searches are flagged as previously seen', () => {
  const state = createDedupState({ seen: [{ video_key: 'meta:77', phash: null }] });
  assert.equal(state.checkIdentity({ platform: 'meta', videoKey: 'meta:77' }), 'previously_seen');
  assert.equal(state.checkIdentity({ platform: 'meta', videoKey: 'meta:78' }), 'new');
});

test('the same ad copy from the same page under a new ID is a near duplicate', () => {
  const state = createDedupState({});
  const ad = { platform: 'meta', author: 'Brand', caption: 'Our hand block printed tablecloth is back in stock, shop now' };
  assert.ok(contentKey(ad));
  assert.equal(state.checkIdentity({ ...ad, videoKey: 'meta:1' }), 'new');
  assert.equal(state.checkIdentity({ ...ad, videoKey: 'meta:2' }), 'near_duplicate');
  assert.equal(contentKey({ platform: 'meta', caption: 'short' }), null);
});

// Photo-like synthetic image: gradient background plus a few large shapes (dense small cells are unrealistic,
// downscaling blends every edge). Thresholds were measured on real product photos; see README.
const photoLike = ([bg1, bg2, a, b, c]) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
    <rect width="400" height="600" fill="url(#g)"/>
    <rect x="60" y="140" width="280" height="300" rx="20" fill="${a}"/>
    <circle cx="200" cy="290" r="90" fill="${b}"/>
    <rect x="120" y="470" width="160" height="60" fill="${c}"/></svg>`)).jpeg({ quality: 90 }).toBuffer();

test('re-uploads are near duplicates; same layout in different colours is not', async () => {
  const original = await photoLike(['#d9cbb5', '#a89880', '#1d3b8a', '#c8a24a', '#333']);
  const reupload = await sharp(original).resize(300).jpeg({ quality: 45 }).toBuffer();
  const recoloured = await photoLike(['#b5c9d9', '#8098a8', '#8a1d3b', '#3b8a1d', '#999']);
  const different = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#123"/><rect width="200" height="600" fill="#fd0"/><circle cx="300" cy="150" r="80" fill="#e44"/></svg>')).jpeg().toBuffer();

  const [fp, fpReupload, fpRecoloured, fpDifferent] = await Promise.all([original, reupload, recoloured, different].map(fingerprint));
  assert.ok(hammingDistance(fp.split('.')[0], fpReupload.split('.')[0]) <= 8);
  assert.equal(isNearDuplicate(fp, fpReupload), true);
  assert.equal(isNearDuplicate(fp, fpRecoloured), false, 'colour check must reject a hash collision');
  assert.equal(isNearDuplicate(fp, fpDifferent), false);

  const state = createDedupState({ seen: [{ video_key: 'x', phash: fpDifferent }] });
  assert.equal(state.checkThumbnail(fp), 'new');
  state.remember(fp);
  assert.equal(state.checkThumbnail(fpReupload), 'near_duplicate');
  assert.equal(state.checkThumbnail(fpDifferent), 'previously_seen');
});

test('repeat searches rotate the query plan so new queries run first', async () => {
  const { rotatePlan } = await import('../src/pipeline/runSearch.js');
  const plan = { queries: ['a', 'b', 'c'], hashtags: ['h1', 'h2', 'h3', 'h4', 'h5'] };
  assert.deepEqual(rotatePlan(plan, 0), plan);
  assert.deepEqual(rotatePlan(plan, 1), { queries: ['b', 'c', 'a'], hashtags: ['h3', 'h4', 'h5', 'h1', 'h2'] });
  assert.deepEqual(rotatePlan({ queries: [], hashtags: [] }, 3), { queries: [], hashtags: [] });
});

test('near-duplicates are tracked per platform inside a search, and rejected copies are remembered too', async () => {
  const { fingerprint } = await import('../src/brain/imageUtils.js');
  const sharp = (await import('sharp')).default;
  const image = await sharp({ create: { width: 120, height: 200, channels: 3, background: '#d65a8c' } }).composite([{ input: await sharp({ create: { width: 40, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer(), top: 40, left: 30 }]).jpeg().toBuffer();
  const fp = await fingerprint(image);
  const state = createDedupState({ seen: [] });
  assert.equal(state.checkThumbnail(fp, 'meta'), 'new');
  state.remember(fp, 'meta');
  assert.equal(state.checkThumbnail(fp, 'meta'), 'near_duplicate', 'a repeated Meta creative is skipped before scoring');
  assert.equal(state.checkThumbnail(fp, 'instagram'), 'new', 'the same creative can still count once on Instagram');
});
