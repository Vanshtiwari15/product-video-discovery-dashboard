import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProductHtml, keywordsFromUrl } from '../src/product/extract.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('JSON-LD Product inside @graph wins and relative image URLs are resolved', () => {
  const product = parseProductHtml(fixture('jsonld.html'), 'https://store.example.com/products/indigo');
  assert.equal(product.title, 'Indigo Floral Block Print Tablecloth');
  assert.equal(product.description, 'Hand block printed 100% cotton tablecloth.');
  assert.equal(product.imageUrl, 'https://store.example.com/images/tablecloth.jpg');
  assert.equal(product.method, 'json-ld');
});

test('falls back to Open Graph when JSON-LD is invalid', () => {
  const product = parseProductHtml(fixture('opengraph.html'), 'https://brand.example.com/bar');
  assert.equal(product.title, 'Protein Dark Chocolate Bar 70%');
  assert.equal(product.imageUrl, 'https://cdn.example.com/bar.png');
  assert.equal(product.method, 'open-graph');
});

test('reads Amazon product markup', () => {
  const product = parseProductHtml(fixture('amazon.html'), 'https://www.amazon.com/dp/B0TEST');
  assert.equal(product.title, 'Oversized Graphic Tee – Black, Vintage Print');
  assert.match(product.description, /Heavyweight cotton/);
  assert.equal(product.imageUrl, 'https://m.media-amazon.com/images/I/tee._AC_SL1500_.jpg');
});

test('bot-check pages raise BLOCKED instead of returning junk', () => {
  assert.throws(() => parseProductHtml(fixture('captcha.html'), 'https://www.amazon.com/dp/B0TEST'), (e) => e.code === 'BLOCKED');
});

test('URL words fallback ignores IDs and path noise', () => {
  assert.equal(keywordsFromUrl('https://www.amazon.in/Cotton-Block-Print-Tablecloth-Indigo/dp/B0ABC12345'), 'cotton block print tablecloth indigo');
  assert.equal(keywordsFromUrl('https://shop.example.com/products/oversized-graphic-tee'), 'oversized graphic tee');
});
