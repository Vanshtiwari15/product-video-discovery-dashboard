import { Agent, fetch } from 'undici';
import { guardedLookup, validatePublicUrl } from '../validation/urlSafety.js';
import { SourceError } from '../errors.js';

const agent = new Agent({ connect: { lookup: guardedLookup, timeout: 10_000 } });
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function readLimited(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new SourceError('TOO_LARGE', `Response exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Fetch for untrusted URLs (product pages, product images, video thumbnails).
// Every hop is validated, DNS is checked at connect time, and body size is capped.
export async function safeFetch(rawUrl, { timeoutMs = 15_000, maxBytes = 5_000_000, accept = '*/*', maxRedirects = 4 } = {}) {
  let url = validatePublicUrl(rawUrl);
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let response;
    try {
      response = await fetch(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal,
        headers: { 'user-agent': BROWSER_UA, accept, 'accept-language': 'en-US,en;q=0.9' },
      });
    } catch (error) {
      const blocked = error.cause?.code === 'EBLOCKEDADDR';
      throw new SourceError(blocked ? 'UNSAFE_URL' : 'NETWORK', blocked ? error.cause.message : `Request failed: ${error.cause?.code || error.message}`, {
        retryable: !blocked,
      });
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      url = validatePublicUrl(new URL(response.headers.get('location'), url).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError('HTTP_' + response.status, `${url.hostname} responded with HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      });
    }
    const body = await readLimited(response, maxBytes);
    return { body, finalUrl: url.toString(), contentType: response.headers.get('content-type') || '' };
  }
  throw new SourceError('TOO_MANY_REDIRECTS', 'Too many redirects');
}
