import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { safeFetch } from '../http/safeFetch.js';
import { withRetry } from '../http/retry.js';
import { SourceError } from '../errors.js';

const clean = (text, max = 2000) => (text ? String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : null);
const absolute = (src, base) => {
  if (!src) return null;
  try {
    return new URL(String(src).trim(), base).toString();
  } catch {
    return null;
  }
};
const firstImage = (image) => {
  if (!image) return null;
  if (Array.isArray(image)) return firstImage(image[0]);
  if (typeof image === 'object') return image.url || image.contentUrl || null;
  return image;
};

function findJsonLdProduct($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      continue;
    }
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      const types = [].concat(node['@type'] || []);
      if (types.includes('Product') || types.includes('ProductGroup')) return node;
      if (node['@graph']) queue.push(...[].concat(node['@graph']));
    }
  }
  return null;
}

// Pure function: HTML in, product fields out. Order: JSON-LD Product, Open Graph, Amazon markup, <title>.
export function parseProductHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const pageTitle = clean($('title').first().text(), 300) || '';
  if (/robot check|captcha|access denied|are you a human/i.test(pageTitle) || $('form[action*="validateCaptcha"]').length) {
    throw new SourceError('BLOCKED', 'The product page returned a bot check instead of the product');
  }

  const meta = (name) => $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
  const ld = findJsonLdProduct($);

  const amazonImage =
    $('#landingImage').attr('data-old-hires') ||
    $('#imgBlkFront').attr('src') ||
    (() => {
      const dynamic = $('#landingImage').attr('data-a-dynamic-image');
      try {
        return dynamic ? Object.keys(JSON.parse(dynamic))[0] : null;
      } catch {
        return null;
      }
    })();
  const amazonBullets = $('#feature-bullets li').map((_, li) => $(li).text()).get().join(' ');

  const title = clean(ld?.name, 300) || clean(meta('og:title'), 300) || clean($('#productTitle').text(), 300) || pageTitle || null;
  const description =
    clean(ld?.description) || clean(meta('og:description')) || clean(amazonBullets) || clean(meta('description')) || null;
  const imageUrl = absolute(firstImage(ld?.image) || meta('og:image') || meta('og:image:secure_url') || meta('twitter:image') || amazonImage, pageUrl);

  const brand = clean(typeof ld?.brand === 'string' ? ld.brand : ld?.brand?.name, 80) || clean($('#bylineInfo').text().replace(/^(visit the|brand:)\s*/i, '').replace(/\s*store$/i, ''), 80) || clean(meta('og:site_name'), 80) || null;
  const category = clean(typeof ld?.category === 'string' ? ld.category.split('>').pop() : null, 80);

  return { title, description, imageUrl, brand, category, method: ld ? 'json-ld' : meta('og:title') ? 'open-graph' : amazonImage ? 'amazon-markup' : 'html-title' };
}

// Shopify exposes /products/<handle>.json on every storefront, which is more reliable than HTML.
async function tryShopifyJson(url, { config, logger }) {
  const match = new URL(url).pathname.match(/\/products\/([^/?#]+)/);
  if (!match) return null;
  const jsonUrl = new URL(`/products/${match[1]}.json`, url).toString();
  try {
    const { body } = await withRetry(() => safeFetch(jsonUrl, { accept: 'application/json', maxBytes: 2_000_000 }), { retries: config.requestRetries });
    const product = JSON.parse(body.toString('utf8')).product;
    if (!product?.title) return null;
    return {
      title: clean(product.title, 300),
      description: clean(product.body_html),
      imageUrl: absolute(product.image?.src || product.images?.[0]?.src, url),
      brand: clean(product.vendor, 80),
      category: clean(product.product_type, 80),
      method: 'shopify-json',
    };
  } catch (error) {
    // Not every /products/ URL is Shopify; fall through to HTML parsing.
    logger.info({ url: jsonUrl, err: error.message }, 'Shopify JSON not available, parsing HTML');
    return null;
  }
}

// Words from the URL path, used only as a labelled fallback when the page itself is blocked.
export function keywordsFromUrl(url) {
  const { pathname } = new URL(url);
  const words = pathname
    .split('/')
    .filter((part) => /[a-z]{3,}/i.test(part) && !/^(dp|gp|product|products|p|item|itm|shop|collections)$/i.test(part))
    .flatMap((part) => part.replace(/\.[a-z]+$/i, '').split(/[-_+]/))
    .filter((word) => /^[a-z]{2,}$/i.test(word));
  return words.slice(0, 8).join(' ').toLowerCase();
}

export const urlHash = (url) => crypto.createHash('sha256').update(url).digest('hex');

export async function extractProduct(url, { repo, config, logger }) {
  const key = urlHash(url);
  const cached = repo.getCachedPage(key, config.productCacheTtlHours);
  if (cached) return { ...cached, cached: true };

  const product =
    (await tryShopifyJson(url, { config, logger })) ||
    (await withRetry(
      async () => {
        const { body, finalUrl, contentType } = await safeFetch(url, { accept: 'text/html,application/xhtml+xml', maxBytes: 4_000_000 });
        if (!/html|xml/i.test(contentType)) throw new SourceError('NOT_HTML', `Expected an HTML page, got ${contentType || 'unknown content'}`);
        return parseProductHtml(body.toString('utf8'), finalUrl);
      },
      { retries: config.requestRetries, onRetry: (error, attempt) => logger.warn({ url, attempt, err: error.message }, 'retrying product page') },
    ));

  if (!product.title && !product.imageUrl) throw new SourceError('NO_PRODUCT', 'No product title or image found on the page');
  repo.cachePage(key, url, product);
  return { ...product, cached: false };
}
