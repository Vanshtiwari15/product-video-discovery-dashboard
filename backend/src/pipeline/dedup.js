import crypto from 'node:crypto';
import { isNearDuplicate } from '../brain/imageUtils.js';

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

// Canonical form for hashing: no scheme, no www, no query or fragment, no trailing slash,
// and Instagram /reel/X, /reels/X and /p/X collapse to the same post.
export function normalizeVideoUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let pathname = url.pathname.replace(/\/+$/, '');
    if (host.endsWith('instagram.com')) pathname = pathname.replace(/^\/(reel|reels|tv)\//, '/p/');
    if (host.endsWith('facebook.com') && url.searchParams.get('id')) return `${host}${pathname}?id=${url.searchParams.get('id')}`;
    return `${host}${pathname}`;
  } catch {
    return String(raw).trim().toLowerCase();
  }
}

export function videoKey({ platform, platformId, url, isDemo }) {
  const prefix = isDemo ? `demo:${platform}` : platform;
  if (platformId) return `${prefix}:${platformId}`;
  if (url) return `${prefix}:u:${sha1(normalizeVideoUrl(url)).slice(0, 20)}`;
  return null;
}

// Same ad copy from the same page is treated as one creative, which catches one ad running under several IDs.
export function contentKey(video) {
  if (video.extra?.collationId) return `${video.platform}:collation:${video.extra.collationId}`;
  const text = (video.caption || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (video.platform !== 'meta' || text.length < 25) return null;
  return `${video.platform}:copy:${sha1(`${(video.author || '').toLowerCase()}|${text.slice(0, 240)}`).slice(0, 20)}`;
}

// Tracks what this search has already kept and what earlier searches showed.
// Within a search, near-duplicate thumbnails are tracked per platform, so the same creative appearing as an
// Instagram Reel and as a Meta ad still counts once on each platform.
export function createDedupState({ seen = [], nearDistance = 8, minColourOverlap = 0.9 }) {
  const seenKeys = new Set(seen.map((row) => row.video_key));
  const seenHashes = seen.map((row) => row.phash).filter(Boolean);
  const searchKeys = new Set();
  const searchContentKeys = new Set();
  const searchHashes = new Map();
  const hashesFor = (platform) => {
    const key = platform || 'all';
    if (!searchHashes.has(key)) searchHashes.set(key, []);
    return searchHashes.get(key);
  };

  const closeTo = (fp, others) => others.some((other) => isNearDuplicate(fp, other, { maxHamming: nearDistance, minColourOverlap }));

  return {
    // Before downloading anything: exact duplicates within the search and exact repeats from earlier searches.
    checkIdentity(video) {
      if (!video.videoKey || searchKeys.has(video.videoKey)) return 'duplicate';
      searchKeys.add(video.videoKey);
      const content = contentKey(video);
      if (content) {
        if (searchContentKeys.has(content)) return 'near_duplicate';
        searchContentKeys.add(content);
      }
      return seenKeys.has(video.videoKey) ? 'previously_seen' : 'new';
    },
    // After the thumbnail is hashed: reposts and re-uploads that carry a different ID.
    checkThumbnail(phash, platform) {
      if (!phash) return 'new';
      if (closeTo(phash, hashesFor(platform))) return 'near_duplicate';
      if (closeTo(phash, seenHashes)) return 'previously_seen';
      return 'new';
    },
    // Every scored thumbnail is remembered (not only accepted ones), so a creative repeated under many ad IDs
    // is scored and verified once instead of on every copy.
    remember(phash, platform) {
      if (phash) hashesFor(platform).push(phash);
    },
  };
}
