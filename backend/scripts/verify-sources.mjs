// Checks the Apify actors before spending money on full searches.
//   npm run verify:sources -- --schema            free: reads actor metadata and input schemas, checks our input fields
//   npm run verify:sources -- --probe --yes       paid: one tiny run per source (5 results each), saves raw responses,
//                                                 reports field coverage, normalisation and thumbnail downloads
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { requestJson } from '../src/http/apiClient.js';
import { safeFetch } from '../src/http/safeFetch.js';
import { normalizeImage } from '../src/brain/imageUtils.js';
import { getActorInputSchema, runActor, splitErrors } from '../src/sources/apify.js';
import { buildInstagramInput, normalizeInstagramItem } from '../src/sources/instagram.js';
import { buildMetaInput, libraryUrl, normalizeMetaAdItem } from '../src/sources/meta.js';

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
if (!config.apify.token) {
  console.error('APIFY_TOKEN is not set in backend/.env');
  process.exit(1);
}
if (!args.includes('--schema') && !args.includes('--probe')) {
  console.log('Use --schema (free) or --probe --yes (paid, 5 results per source).');
  process.exit(2);
}

const hashtag = value('hashtag', 'snowboard');
const query = value('query', 'snowboard');
const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const SOURCES = [
  {
    name: 'instagram', actor: config.apify.instagramActor,
    input: (schema) => buildInstagramInput(schema, [hashtag], 5),
    normalize: normalizeInstagramItem,
    fields: [['id'], ['shortCode'], ['type'], ['productType'], ['caption'], ['displayUrl'], ['videoUrl'], ['timestamp'], ['ownerUsername'], ['url']],
  },
  {
    name: 'meta', actor: config.apify.metaActor,
    input: (schema) => buildMetaInput(schema, libraryUrl(query, config.meta.countries[0] || 'ALL'), 5),
    normalize: normalizeMetaAdItem,
    fields: [['adArchiveID', 'ad_archive_id'], ['pageName', 'page_name'], ['startDate', 'start_date'], ['collationID', 'collation_id'], ['snapshot.body.text', 'snapshot.cards.0.body'], ['snapshot.videos.0.video_preview_image_url', 'snapshot.videos.0.videoPreviewImageUrl', 'snapshot.cards.0.video_preview_image_url'], ['snapshot.videos.0.video_hd_url', 'snapshot.videos.0.video_sd_url', 'snapshot.cards.0.video_hd_url']],
  },
];

let failures = 0;
for (const source of SOURCES) {
  console.log(`\n=== ${source.name}: ${source.actor}`);
  const schema = await getActorInputSchema(source.actor, { config, logger });
  const input = source.input(schema);
  if (args.includes('--schema')) {
    try {
      const actor = await requestJson(`${config.apify.baseUrl}/acts/${encodeURIComponent(source.actor)}`, { headers: { authorization: `Bearer ${config.apify.token}` }, label: 'apify-actor' });
      const pricing = actor?.data?.pricingInfos?.at?.(-1);
      console.log(`actor: ${actor?.data?.title || actor?.data?.name}; pricing: ${pricing ? JSON.stringify(pricing) : 'not reported by the API (check the actor page)'}`);
    } catch (error) {
      console.log(`actor metadata failed: ${error.message}`);
      failures += 1;
    }
    if (!schema) {
      console.log('input schema: NOT READABLE (default field names will be used)');
    } else {
      const props = Object.keys(schema.properties || {});
      console.log(`input schema fields: ${props.join(', ')}`);
      for (const key of Object.keys(input)) console.log(`  ${props.includes(key) ? 'OK     ' : 'MISSING'} ${key}`);
      if (schema.properties?.resultsType?.enum) console.log(`  resultsType options: ${schema.properties.resultsType.enum.join(', ')}`);
      failures += Object.keys(input).filter((key) => !props.includes(key)).length;
    }
    console.log(`input we would send: ${JSON.stringify(input)}`);
  }

  if (args.includes('--probe')) {
    if (!args.includes('--yes')) {
      console.log('--probe starts a paid Apify run (max 5 results). Re-run with --yes.');
      process.exit(2);
    }
    const started = Date.now();
    try {
      const { items: raw, run } = await runActor(source.actor, input, { config, logger, label: `probe-${source.name}`, maxItems: 5 });
      const rawDir = path.resolve('..', 'evaluation', 'raw');
      fs.mkdirSync(rawDir, { recursive: true });
      const rawFile = path.join(rawDir, `${source.name}-${run.id}.json`);
      fs.writeFileSync(rawFile, JSON.stringify({ actor: source.actor, input, run, items: raw }, null, 2));
      const { items, errors } = splitErrors(raw);
      console.log(`run ${run.id}: ${run.status}, ${raw.length} items in ${Math.round((Date.now() - started) / 1000)} s, Apify-reported usage ${run.usageUsd ?? 'n/a'} USD`);
      if (errors.length) console.log(`actor errors: ${errors.join(' | ')}`);
      console.log('field coverage (items with the field / total):');
      for (const alternatives of source.fields) {
        const present = items.filter((item) => alternatives.some((f) => get(item, f) !== undefined && get(item, f) !== null && get(item, f) !== '')).length;
        console.log(`  ${String(present).padStart(2)}/${items.length}  ${alternatives.join(' | ')}`);
      }
      const normalized = items.map(source.normalize).filter(Boolean);
      console.log(`normalised as videos: ${normalized.length}/${items.length}`);
      let thumbs = 0;
      for (const video of normalized) {
        try {
          await normalizeImage((await safeFetch(video.thumbnailUrl, { accept: 'image/*', timeoutMs: 12_000 })).body);
          thumbs += 1;
        } catch (error) {
          console.log(`  thumbnail failed for ${video.url}: ${error.message}`);
        }
      }
      console.log(`thumbnails downloaded and decoded: ${thumbs}/${normalized.length}`);
      normalized.slice(0, 3).forEach((v) => console.log(`  example: ${v.url} | ${v.author} | ${(v.caption || '').slice(0, 60)}`));
      console.log(`raw response saved: ${rawFile}`);
      if (!normalized.length || !thumbs) failures += 1;
    } catch (error) {
      console.log(`probe failed: ${error.code || ''} ${error.message}`);
      failures += 1;
    }
  }
}
console.log(failures ? `\n${failures} problem(s) found` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
