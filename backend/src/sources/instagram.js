import { getActorInputSchema, pickField, runActor, splitErrors } from './apify.js';

const isReel = (item) => item.type === 'Video' || item.productType === 'clips' || Boolean(item.videoUrl);

export function normalizeInstagramItem(item) {
  if (!item || !isReel(item)) return null;
  const shortCode = item.shortCode || item.shortcode || null;
  const url = shortCode ? `https://www.instagram.com/reel/${shortCode}/` : item.url || null;
  const platformId = item.id ? String(item.id) : shortCode;
  if (!platformId && !url) return null;
  return {
    platformId,
    url,
    videoUrl: item.videoUrl || null,
    thumbnailUrl: item.displayUrl || item.thumbnailUrl || item.images?.[0] || null,
    caption: item.caption || null,
    author: item.ownerUsername || item.ownerFullName || null,
    publishedAt: item.timestamp || null,
    extra: { likes: item.likesCount ?? null, views: item.videoViewCount ?? item.videoPlayCount ?? null, productType: item.productType || null },
  };
}

// Input field names are matched against the actor's live input schema; defaults are the documented names.
export function buildInstagramInput(schema, hashtags, limit) {
  const input = { [pickField(schema, ['hashtags', 'hashtag']) ?? 'hashtags']: hashtags };
  const limitField = pickField(schema, ['resultsLimit', 'resultsPerPage', 'maxItems', 'limit']);
  if (limitField) input[limitField] = limit;
  const typeEnum = schema?.properties?.resultsType?.enum;
  if (pickField(schema, ['resultsType']) && (!typeEnum || typeEnum.includes('reels'))) input.resultsType = 'reels';
  return input;
}

// Input for the Instagram Reel Scraper (reels from specific accounts), matched against its live schema.
export function buildReelInput(schema, handles, limit) {
  const field = pickField(schema, ['username', 'usernames', 'directUrls']) ?? 'username';
  const input = { [field]: field === 'directUrls' ? handles.map((h) => `https://www.instagram.com/${h}/reels/`) : handles };
  const limitField = pickField(schema, ['resultsLimit', 'resultsPerPage', 'maxItems', 'limit']);
  if (limitField) input[limitField] = limit;
  return input;
}

// Instagram Reels via Apify: the plan's hashtags (brand+model first, a few per run) and, when the brand's
// official account is known, that account's own Reels in parallel on the first round. Hashtags are never derived
// by splitting queries into single words: that produced tags like #grey #large #text with no relevant videos.
export function createInstagramSource({ config, logger }) {
  return {
    platform: 'instagram',
    label: 'Instagram Reels',
    isConfigured: () => Boolean(config.apify.token),
    notConfiguredMessage: 'Instagram is not configured: set APIFY_TOKEN in backend/.env (see README, Video sources).',
    createSession({ hashtags = [], accounts = [], signal }) {
      const tags = [...new Set(hashtags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9_]/g, '')))].filter((t) => t.length >= 3).slice(0, 16);
      const handles = config.apify.instagramBrandReels ? accounts.slice(0, 2) : [];
      const batchSize = Math.max(1, config.apify.hashtagsPerRun ?? 4);
      let index = 0;
      let accountsDone = handles.length === 0;

      async function hashtagRun(batch, limit) {
        const schema = await getActorInputSchema(config.apify.instagramActor, { config, logger });
        const perTag = Math.min(Math.ceil(limit / batch.length) + 10, 60);
        return runActor(config.apify.instagramActor, buildInstagramInput(schema, batch, perTag), { config, signal, logger, label: 'apify-instagram', maxItems: perTag * batch.length });
      }
      async function accountRun(limit) {
        const schema = await getActorInputSchema(config.apify.instagramReelActor, { config, logger });
        const perAccount = Math.min(limit, 40);
        return runActor(config.apify.instagramReelActor, buildReelInput(schema, handles, perAccount), { config, signal, logger, label: 'apify-instagram-reels', maxItems: perAccount * handles.length });
      }

      return {
        async next(limit) {
          if (index >= tags.length && accountsDone) return { items: [], done: true, label: null };
          const batch = tags.slice(index, index + batchSize);
          const withAccounts = !accountsDone;
          const jobs = [];
          if (batch.length) jobs.push(hashtagRun(batch, limit).then((r) => ({ ...r, kind: 'tags' })));
          if (withAccounts) {
            jobs.push(accountRun(limit).then((r) => ({ ...r, kind: 'accounts' }), (error) => {
              // The account run is a bonus source: its failure is reported, not fatal, unless it was the only job.
              if (!batch.length) throw error;
              return { kind: 'accounts', items: [], run: null, warning: `Instagram brand Reels (@${handles.join(', @')}) failed: ${error.message}` };
            }));
          }
          // A failed hashtag run throws before the cursor moves, so a retry repeats the same batch.
          const results = await Promise.all(jobs);
          index += batch.length;
          if (withAccounts) accountsDone = true;
          const items = [];
          const warnings = [];
          const runs = [];
          let rawCount = 0;
          for (const result of results) {
            if (result.warning) warnings.push(result.warning);
            if (result.run) runs.push(result.run);
            rawCount += result.items.length;
            const { items: ok, errors } = splitErrors(result.items);
            warnings.push(...errors.map((e) => `Instagram: ${e}`));
            const foundBy = result.kind === 'accounts' ? `@${handles.join(' @')}` : batch.map((tag) => `#${tag}`).join(' ');
            items.push(...ok.map(normalizeInstagramItem).filter(Boolean).map((item) => ({ ...item, foundBy })));
          }
          const label = [batch.length ? batch.map((tag) => `#${tag}`).join(' ') : null, results.some((r) => r.kind === 'accounts') ? `@${handles.join(' @')} reels` : null].filter(Boolean).join(' + ');
          return { items, done: index >= tags.length && accountsDone, label, warnings, runs, run: runs[0] ?? null, rawCount };
        },
      };
    },
  };
}
