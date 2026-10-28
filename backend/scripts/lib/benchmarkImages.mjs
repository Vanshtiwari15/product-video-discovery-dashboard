// Labelled benchmark images from a public Shopify demo store (Shopify's Hydrogen demo catalogue).
// Each snowboard has a packshot plus other photos of the same board, including one in use on the snow,
// so "exact product in a scene" vs "different board in the same kind of scene" can be measured.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFetch } from '../../src/http/safeFetch.js';
import { normalizeImage } from '../../src/brain/imageUtils.js';

export const DEFAULT_STORE = 'https://hydrogen-preview.myshopify.com';

export async function loadCatalogue(store, cacheDir) {
  const { body } = await safeFetch(`${store}/products.json?limit=250`, { accept: 'application/json' });
  const products = JSON.parse(body.toString('utf8')).products;
  await fs.mkdir(cacheDir, { recursive: true });
  const image = async (handle, index, src) => {
    const file = path.join(cacheDir, `${handle}-${index}.jpg`);
    try {
      return await fs.readFile(file);
    } catch {
      const normalized = await normalizeImage((await safeFetch(src, { accept: 'image/*', maxBytes: 15_000_000 })).body);
      await fs.writeFile(file, normalized);
      return normalized;
    }
  };
  const boards = products.filter((p) => /snowboard/i.test(p.product_type || '') && p.images.length >= 3);
  const unrelated = products.filter((p) => /wax/i.test(p.title) && !/bundle/i.test(p.title) && p.images.length);
  return { boards, unrelated, image };
}
