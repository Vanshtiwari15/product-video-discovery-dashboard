import { createInstagramSource } from './instagram.js';
import { createMetaSource } from './meta.js';
import { createDemoSource } from './demo.js';

export function createSources({ config, logger }) {
  return { instagram: createInstagramSource({ config, logger }), meta: createMetaSource({ config, logger }) };
}

// Demo sources need the product photo to synthesise "good" matches, so they are built per search.
export function createDemoSources(productImage) {
  return { instagram: createDemoSource('instagram', { productImage }), meta: createDemoSource('meta', { productImage }) };
}
