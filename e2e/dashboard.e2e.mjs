// Browser check of the dashboard against a running backend in DEMO_MODE and the Vite dev server.
// Usage: CHROME_PATH=<path to chrome> APP_URL=http://localhost:5173 PRODUCT_IMAGE=<jpg> node dashboard.e2e.mjs
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://localhost:5173';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

async function search(query, image) {
  await page.goto(APP);
  await page.fill('#query', query);
  if (image) await page.setInputFiles('input[type=file]', image);
  await page.click('button[type=submit]');
  await page.waitForSelector('.timeline', { timeout: 15_000 });
  check(`progress timeline appears for "${query}"`, true);
  await page.waitForFunction(() => !document.querySelector('.step-active') && document.querySelectorAll('.tab-count').length === 3, null, { timeout: 180_000 });
}
const cardCount = () => page.locator('.video-card').count();
const tabCount = async (index) => Number((await page.locator('.tab-count').nth(index).innerText()).split('/')[0].trim());

await search('hydrogen snowboard', process.env.PRODUCT_IMAGE);
check('demo banner is shown for synthetic data', await page.locator('.notice-demo').isVisible());
check('product panel shows title and image', (await page.locator('.product-panel h1').innerText()).length > 0 && (await page.locator('.product-image img').count()) === 1);
const igNew = await tabCount(0);
check('Instagram tab count matches visible cards', igNew === (await cardCount()), `tab ${igNew}, cards ${await cardCount()}`);
const shortfallVisible = await page.locator('.notice-warning, .notice-error').count();
check('shortfall against 20 is explained when below target', igNew >= 20 || shortfallVisible > 0, `${shortfallVisible} notices`);
await page.click('.tab:has-text("Meta Ad Library")');
check('Meta tab count matches visible cards', (await tabCount(1)) === (await cardCount()));
await page.click('.tab:has-text("All sources")');
check('All sources tab sums both sources', (await cardCount()) === igNew + (await tabCount(1)));

const before = await cardCount();
await page.check('text=Show below threshold');
const withLow = await cardCount();
check('below-threshold toggle reveals low matches', withLow > before, `${before} -> ${withLow}`);
await page.locator('input[type=range]').fill('60');
const scores = await page.locator('.score-value').allInnerTexts();
check('min score filter applies', scores.every((s) => Number(s) >= 60), `${scores.length} cards, min ${Math.min(...scores.map(Number))}`);
await page.locator('input[type=range]').fill('0');
await page.selectOption('select >> nth=0', 'newest');
const dates = await page.locator('.card-meta time').evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute('datetime'))));
check('newest-first sort orders by date', dates.every((d, i) => i === 0 || dates[i - 1] >= d), `${dates.length} dated cards`);
await page.click('.video-card .link-button >> nth=0');
check('"Why this score" lists the evidence', (await page.locator('.reasons li').count()) >= 2);

await search('hydrogen snowboard', process.env.PRODUCT_IMAGE);
const seenLabel = await page.locator('text=/Show previously seen \\(\\d+\\)/').innerText();
const hiddenSeen = Number(seenLabel.match(/\((\d+)\)/)[1]);
const beforeSeen = await cardCount();
await page.check('text=/Show previously seen/');
await page.check('text=Show below threshold');
const afterSeen = await cardCount();
const seenBadges = await page.locator('.badge-seen').count();
check('repeat search hides previously seen videos until toggled', hiddenSeen > 0 && afterSeen > beforeSeen && seenBadges > 0, `${hiddenSeen} hidden, cards ${beforeSeen} -> ${afterSeen}, ${seenBadges} "Seen before" badges`);

check('history lists both searches', (await page.locator('.history-item').count()) >= 2);
await page.goto(APP);
await page.fill('#query', 'http://192.168.1.10/products/x');
await page.click('button[type=submit]');
await page.waitForSelector('.notice-error', { timeout: 10_000 });
check('unsafe URL shows a clear error', /Private or reserved IP/.test(await page.locator('.notice-error').innerText()));
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
