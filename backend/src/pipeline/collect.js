import path from 'node:path';
import { safeFetch } from '../http/safeFetch.js';
import { fingerprint, normalizeImage, saveMedia } from '../brain/imageUtils.js';
import { videoKey } from './dedup.js';

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

async function loadThumbnail(video, mediaDir) {
  try {
    const raw = video.thumbnailBuffer ?? (video.thumbnailUrl ? (await safeFetch(video.thumbnailUrl, { accept: 'image/*', timeoutMs: 12_000, maxBytes: 6_000_000 })).body : null);
    if (!raw) return null;
    const buffer = await normalizeImage(raw);
    const { file } = await saveMedia(path.join(mediaDir, 'thumbs'), buffer);
    return { buffer, file, phash: await fingerprint(buffer) };
  } catch {
    return null;
  }
}

export function emptyStats(target) {
  return { status: 'running', target, accepted: 0, verified: 0, unverifiedAccepted: 0, providerRuns: 0, providerItems: 0, providerCostUsd: 0, fetched: 0, duplicates: 0, nearDuplicates: 0, previouslySeen: 0, lowMatch: 0, unscored: 0, rounds: 0, queriesTried: [], warnings: [], error: null, retryPossible: false };
}

// Pulls pages from one source until enough new, relevant videos are kept, the source runs out of query
// expansions, the round limit or the free-tier item budget is hit. Each kept video is persisted immediately.
// Per-round errors that are marked retryable (e.g. Apify TIMED-OUT with 0 results) are retried up to
// MAX_RETRYABLE_ERRORS times so one flaky actor run cannot abort the whole source. Unexpected errors end the
// source but never discard what was already collected.
export async function collectFromSource({ source, searchPlan, searchId, dedup, scoreBatch, repo, config, signal, onProgress }) {
  const stats = emptyStats(config.minPerSource);
  const acceptedKeys = [];
  const phashByKey = new Map();
  const maxRetryableErrors = config.maxRetryableErrors ?? 3;
  const itemBudget = config.maxProviderItemsPerSource ?? Infinity;
  let retryableErrors = 0;
  let successfulRounds = 0;

  try {
    const session = source.createSession({ ...searchPlan, signal });
    while (stats.accepted < config.minPerSource && successfulRounds < config.maxRoundsPerSource && !signal.aborted) {
      if (stats.providerItems >= itemBudget) {
        stats.warnings.push(`${source.label}: stopped at the free-tier budget of ${itemBudget} provider items for this search (MAX_PROVIDER_ITEMS_PER_SOURCE).`);
        break;
      }
      const needed = config.minPerSource - stats.accepted;
      let page;
      try {
        page = await session.next(Math.max(needed * 3, 30));
      } catch (error) {
        if (error.retryable && retryableErrors < maxRetryableErrors && !signal.aborted) {
          retryableErrors += 1;
          stats.rounds += 1;
          const msg = `${source.label}: round error (${error.message}), retrying (${retryableErrors}/${maxRetryableErrors})`;
          stats.warnings.push(msg);
          onProgress({ ...stats, message: msg });
          continue;
        }
        stats.error = error.message;
        stats.errorCode = error.code || 'ERROR';
        stats.retryPossible = Boolean(error.retryable || ['ABORTED', 'TIMEOUT', 'SOURCE_TIMEOUT'].includes(error.code));
        stats.warnings.push(`${source.label}: stopped after source error (${error.message})`);
        onProgress({ ...stats, message: `${stats.accepted} matches retained; source stopped: ${error.message}` });
        break;
      }

      stats.rounds += 1;
      successfulRounds += 1;
      if (page.label) stats.queriesTried.push(page.label);
      if (page.warnings?.length) stats.warnings.push(...page.warnings);
      if (page.run?.status && page.run.status !== 'SUCCEEDED') stats.warnings.push(`${source.label}: actor run ended ${page.run.status.toLowerCase()}; retaining available partial data.`);
      stats.fetched += page.items.length;
      for (const run of page.runs || (page.run ? [page.run] : [])) {
        stats.providerRuns += 1;
        if (run.usageUsd) stats.providerCostUsd = Math.round((stats.providerCostUsd + run.usageUsd) * 10000) / 10000;
      }
      if (page.run || page.runs) stats.providerItems += page.rawCount ?? page.items.length;
      onProgress({ ...stats, message: `Fetched ${page.items.length} from ${page.label || 'source'}` });

      const fresh = [];
      for (const item of page.items) {
        const video = { ...item, platform: source.platform, foundBy: item.foundBy || page.label };
        video.videoKey = videoKey(video);
        const identity = dedup.checkIdentity(video);
        if (identity === 'duplicate') stats.duplicates += 1;
        else if (identity === 'near_duplicate') stats.nearDuplicates += 1;
        else fresh.push({ video, previouslySeen: identity === 'previously_seen' });
      }

      const withThumbs = await mapLimit(fresh, 6, async (entry) => {
        const thumb = await loadThumbnail(entry.video, config.mediaDir);
        return { ...entry, thumb };
      });

      const toScore = [];
      for (const entry of withThumbs) {
        const thumbCheck = dedup.checkThumbnail(entry.thumb?.phash, source.platform);
        if (thumbCheck === 'near_duplicate') {
          stats.nearDuplicates += 1;
          continue;
        }
        if (thumbCheck === 'previously_seen') entry.previouslySeen = true;
        dedup.remember(entry.thumb?.phash, source.platform);
        toScore.push(entry);
      }

      // Previously seen videos never count toward the target, so they are not sent to the verifier.
      const need = config.minPerSource - stats.accepted;
      const scored = await scoreBatch(
        toScore.map(({ video, thumb, previouslySeen }) => ({ thumbnailBuffer: thumb?.buffer ?? null, caption: video.caption, author: video.author, title: video.extra?.title ?? null, videoUrl: video.videoUrl, skipVerify: previouslySeen })),
        { need },
      );

      for (const [index, entry] of toScore.entries()) {
        const { frameBuffer, ...result } = scored[index];
        if (frameBuffer) result.detail.frameFile = (await saveMedia(path.join(config.mediaDir, 'thumbs'), frameBuffer)).file;
        const video = { ...entry.video, thumbnailFile: entry.thumb?.file ?? null, phash: entry.thumb?.phash ?? null };
        delete video.thumbnailBuffer;
        repo.saveSearchVideo(searchId, video, { ...result, previouslySeen: entry.previouslySeen });

        if (result.detail?.verified) stats.verified += 1;
        if (entry.previouslySeen) stats.previouslySeen += 1;
        else if (result.matchStatus === 'accepted') {
          stats.accepted += 1;
          if (result.detail?.verified === false) stats.unverifiedAccepted += 1;
          acceptedKeys.push(video.videoKey);
          phashByKey.set(video.videoKey, video.phash);
        } else if (result.matchStatus === 'low_match') stats.lowMatch += 1;
        else stats.unscored += 1;
      }

      onProgress({ ...stats, message: `${stats.accepted}/${config.minPerSource} relevant after ${stats.rounds} round${stats.rounds > 1 ? 's' : ''}` });
      if (page.done) break;
    }
  } catch (error) {
    stats.error = `${source.label}: ${error.message}`;
    stats.errorCode = error.code || 'ERROR';
    stats.retryPossible = Boolean(error.retryable);
    stats.warnings.push(`${source.label}: stopped after an unexpected error (${error.message}); ${stats.accepted} matches retained.`);
  }

  repo.markSeen(acceptedKeys, searchId, phashByKey);
  if (stats.fetched === 0 && stats.warnings.length && !stats.error) {
    stats.error = stats.warnings.join('; ');
    stats.errorCode = 'SOURCE_RESPONSE_ERROR';
  }
  stats.status = stats.accepted >= config.minPerSource ? 'ok' : stats.error && stats.fetched === 0 ? 'failed' : 'short';
  return stats;
}
