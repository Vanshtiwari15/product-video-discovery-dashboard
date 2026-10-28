import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp, validatePublicUrl, guardedLookup } from '../src/validation/urlSafety.js';
import { parseSearchInput } from '../src/validation/input.js';

test('blocks internal, private and malformed URLs', () => {
  const blocked = [
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.4.4/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://printer.local/',
    'http://db.internal/',
    'http://intranet/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:22/',
    'not a url',
  ];
  for (const url of blocked) assert.throws(() => validatePublicUrl(url), (e) => e.code === 'UNSAFE_URL', url);
});

test('allows public product URLs', () => {
  for (const url of ['https://www.amazon.in/dp/B0TEST', 'https://shop.example.com/products/tee?variant=1', 'http://93.184.215.14/']) {
    assert.equal(validatePublicUrl(url).protocol.startsWith('http'), true);
  }
});

test('isPublicIp classifies ranges', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
});

test('connect-time lookup refuses hostnames that resolve to private addresses', async () => {
  const error = await new Promise((resolve) => guardedLookup('localhost', {}, (err) => resolve(err)));
  assert.equal(error.code, 'EBLOCKEDADDR');
});

test('parseSearchInput separates keywords from URLs and validates both', () => {
  assert.deepEqual(parseSearchInput({ query: '  oversized   graphic tee ' }), { inputType: 'keyword', value: 'oversized graphic tee' });
  assert.equal(parseSearchInput({ query: 'shop.example.com/products/tee' }).inputType, 'url');
  assert.throws(() => parseSearchInput({}), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => parseSearchInput({ query: 'a' }), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => parseSearchInput({ query: 'http://192.168.0.10/products/x' }), (e) => e.code === 'UNSAFE_URL');
  assert.throws(() => parseSearchInput({ query: 'x'.repeat(201) }), (e) => e.code === 'BAD_REQUEST');
});
