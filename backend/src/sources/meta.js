import { getActorInputSchema, pickField, runActor, splitErrors } from './apify.js';
import { requestJson } from '../http/apiClient.js';

const stripHtml = (text) => (text ? String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null);
const adLibraryLink = (id) => `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`;

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// The Apify actor's output has used both camelCase and snake_case keys over time; accept both.
export function normalizeMetaAdItem(item) {
  if (!item) return null;
  const id = item.adArchiveID ?? item.adArchiveId ?? item.ad_archive_id ?? item.adid ?? null;
  const snapshot = item.snapshot ?? {};
  const cards = snapshot.cards ?? [];
  const media = [...(snapshot.videos ?? []), ...cards].find((v) => v && (v.video_preview_image_url || v.videoPreviewImageUrl || v.video_hd_url || v.video_sd_url));
  if (!id || !media) return null;

  const body = typeof snapshot.body === 'string' ? snapshot.body : snapshot.body?.text ?? snapshot.body?.markup?.__html;
  return {
    platformId: String(id),
    url: adLibraryLink(id),
    videoUrl: media.video_hd_url ?? media.videoHdUrl ?? media.video_sd_url ?? media.videoSdUrl ?? null,
    thumbnailUrl: media.video_preview_image_url ?? media.videoPreviewImageUrl ?? null,
    caption: stripHtml(body || cards[0]?.body || snapshot.title),
    author: item.pageName ?? item.page_name ?? snapshot.page_name ?? null,
    publishedAt: toIso(item.startDate ?? item.start_date ?? item.startDateFormatted),
    extra: {
      title: stripHtml(snapshot.title ?? media.title) || null,
      collationId: item.collationID ?? item.collation_id ?? null,
      collationCount: item.collationCount ?? item.collation_count ?? null,
      platforms: item.publisherPlatform ?? item.publisher_platform ?? null,
      isActive: item.isActive ?? item.is_active ?? null,
    },
  };
}

export function libraryUrl(query, country) {
  const params = new URLSearchParams({ active_status: 'all', ad_type: 'all', country, q: query, search_type: 'keyword_unordered', media_type: 'video' });
  return `https://www.facebook.com/ads/library/?${params}`;
}

export function buildMetaInput(schema, url, limit) {
  const input = { [pickField(schema, ['startUrls', 'urls']) ?? 'startUrls']: [{ url }] };
  const limitField = pickField(schema, ['resultsLimit', 'count', 'maxItems', 'limit']);
  if (limitField) input[limitField] = limit;
  return input;
}

// Meta Ad Library via the Apify Facebook Ads Library scraper: returns video preview images and video files.
// Each round runs up to META_QUERIES_PER_ROUND plan queries in parallel (most specific first). The country list
// in config is iterated on the first query to broaden reach.
function createApifyMetaSource({ config, logger }) {
  return {
    platform: 'meta',
    label: 'Meta Ad Library',
    isConfigured: () => Boolean(config.apify.token),
    notConfiguredMessage: 'Meta Ad Library is not configured: set APIFY_TOKEN in backend/.env (see README, Video sources).',
    createSession({ queries, signal }) {
      let slotIndex = 0;
      const countries = config.meta.countries.length ? config.meta.countries : ['ALL'];
      const slots = queries.flatMap((q, qi) => (qi === 0 ? countries.map((c) => ({ query: q, country: c })) : [{ query: q, country: countries[0] }]));
      const perRound = Math.max(1, config.apify.metaQueriesPerRound ?? 2);
      return {
        async next(limit) {
          if (slotIndex >= slots.length) return { items: [], done: true, label: null };
          const batch = slots.slice(slotIndex, slotIndex + perRound);
          const schema = await getActorInputSchema(config.apify.metaActor, { config, logger });
          // Request more than needed: image-only ads and repeated creatives are dropped later.
          const wanted = Math.min(Math.ceil(limit / batch.length) + 20, 100);
          const settled = await Promise.allSettled(batch.map(({ query, country }) => runActor(
            config.apify.metaActor,
            buildMetaInput(schema, libraryUrl(query, country), wanted),
            { config, signal, logger, label: 'apify-meta', maxItems: wanted },
          )));
          const failures = settled.filter((r) => r.status === 'rejected');
          // Only when every query failed does the round throw; the cursor stays put so a retry repeats them.
          if (failures.length === settled.length) throw failures[0].reason;
          slotIndex += batch.length;
          const items = [];
          const warnings = failures.map((f) => `Meta: one query failed (${f.reason.message})`);
          const runs = [];
          let rawCount = 0;
          settled.forEach((result, i) => {
            if (result.status !== 'fulfilled') return;
            const { items: raw, run } = result.value;
            runs.push(run);
            rawCount += raw.length;
            const { items: ok, errors } = splitErrors(raw);
            warnings.push(...errors.map((e) => `Meta: ${e}`));
            const foundBy = `"${batch[i].query}"`;
            items.push(...ok.map(normalizeMetaAdItem).filter(Boolean).map((item) => ({ ...item, foundBy })));
          });
          const label = batch.map(({ query, country }) => `"${query}"${countries.length > 1 && country !== countries[0] ? ` (${country})` : ''}`).join(' + ');
          return { items, done: slotIndex >= slots.length, label, warnings, runs, run: runs[0] ?? null, rawCount };
        },
      };
    },
  };
}

// Official Ad Library API. Legitimate and free, but it returns no thumbnails or video files,
// so its results are stored as unscored and do not count towards the 20-video target.
function createGraphMetaSource({ config, logger }) {
  const fields = 'id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,page_name,publisher_platforms';
  return {
    platform: 'meta',
    label: 'Meta Ad Library (official API)',
    isConfigured: () => Boolean(config.meta.graphToken),
    notConfiguredMessage: 'META_PROVIDER=graph needs META_ACCESS_TOKEN (see README, Video sources).',
    createSession({ queries, signal }) {
      let index = 0;
      let nextUrl = null;
      return {
        async next(limit) {
          if (!nextUrl && index >= queries.length) return { items: [], done: true, label: null };
          const startingQuery = !nextUrl;
          const query = startingQuery ? queries[index] : queries[index - 1];
          const url =
            nextUrl ||
            `https://graph.facebook.com/${config.meta.graphVersion}/ads_archive?${new URLSearchParams({
              search_terms: query,
              ad_reached_countries: JSON.stringify(config.meta.countries),
              ad_type: 'ALL',
              ad_active_status: 'ALL',
              media_type: 'VIDEO',
              fields,
              limit: String(Math.min(limit, 100)),
              access_token: config.meta.graphToken,
            })}`;
          const data = await requestJson(url, { signal, label: 'meta-graph', logger, retries: config.requestRetries });
          if (startingQuery) index += 1;
          nextUrl = data?.paging?.next || null;
          const items = (data?.data || []).map((ad) => ({
            platformId: String(ad.id),
            url: adLibraryLink(ad.id),
            videoUrl: null,
            thumbnailUrl: null,
            caption: ad.ad_creative_bodies?.[0] || ad.ad_creative_link_titles?.[0] || null,
            author: ad.page_name || null,
            publishedAt: toIso(ad.ad_delivery_start_time || ad.ad_creation_time),
            extra: { platforms: ad.publisher_platforms || null, source: 'graph-api' },
          }));
          return { items, done: !nextUrl && index >= queries.length, label: `"${query}" (API)` };
        },
      };
    },
  };
}

export function createMetaSource(deps) {
  return deps.config.meta.provider === 'graph' ? createGraphMetaSource(deps) : createApifyMetaSource(deps);
}
