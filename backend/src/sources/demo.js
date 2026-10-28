import crypto from 'node:crypto';
import sharp from 'sharp';

// DEMO_MODE only. Produces clearly labelled synthetic records so the pipeline (dedup, scoring, UI)
// can be exercised without credentials. Never used when DEMO_MODE is off, never mixed with real data.
function seeded(seedText) {
  let seed = crypto.createHash('sha1').update(seedText).digest().readUInt32LE(0);
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

async function abstractThumbnail(rand) {
  const hue = Math.floor(rand() * 360);
  const shapes = Array.from({ length: 6 }, () => {
    const color = `hsl(${(hue + rand() * 120) % 360},${40 + rand() * 40}%,${30 + rand() * 40}%)`;
    return `<circle cx="${rand() * 288}" cy="${rand() * 512}" r="${30 + rand() * 90}" fill="${color}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="512"><rect width="100%" height="100%" fill="hsl(${hue},25%,85%)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

async function productThumbnail(productImage, rand) {
  const meta = await sharp(productImage).metadata();
  const crop = 0.65 + rand() * 0.3;
  const width = Math.max(32, Math.floor(meta.width * crop));
  const height = Math.max(32, Math.floor(meta.height * crop));
  const left = Math.floor((meta.width - width) * rand());
  const top = Math.floor((meta.height - height) * rand());
  const product = await sharp(productImage).extract({ left, top, width, height }).resize(240, 240, { fit: 'inside' }).modulate({ brightness: 0.85 + rand() * 0.3 }).toBuffer();
  // Varied scene: random background colour and a couple of props, product placed at a random position.
  const hue = Math.floor(rand() * 360);
  const props = Array.from({ length: 3 }, () => `<rect x="${rand() * 250}" y="${rand() * 480}" width="${30 + rand() * 90}" height="${20 + rand() * 120}" fill="hsl(${(hue + 40 + rand() * 80) % 360},30%,${35 + rand() * 40}%)"/>`).join('');
  const scene = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="288" height="512"><rect width="100%" height="100%" fill="hsl(${hue},${15 + rand() * 30}%,${55 + rand() * 30}%)"/>${props}</svg>`);
  const resized = await sharp(product).resize(Math.round(160 + rand() * 100), null, { fit: 'inside' }).toBuffer();
  const { width: pw, height: ph } = await sharp(resized).metadata();
  return sharp(scene)
    .composite([{ input: resized, top: Math.floor(rand() * Math.max(1, 512 - ph)), left: Math.floor(rand() * Math.max(1, 288 - pw)) }])
    .jpeg()
    .toBuffer();
}

export function createDemoSource(platform, { productImage }) {
  const label = platform === 'instagram' ? 'Instagram Reels (demo data)' : 'Meta Ad Library (demo data)';
  return {
    platform,
    label,
    isConfigured: () => true,
    createSession({ queries }) {
      let page = 0;
      let previousId = null;
      const pagesPerQuery = new Map();
      return {
        async next() {
          // Content depends only on (query, page of that query), like a real scraper: the same hashtag
          // returns the same top posts, so repeat searches meet videos they have already shown.
          const query = queries[page % queries.length] || 'demo';
          const queryPage = pagesPerQuery.get(query) ?? 0;
          pagesPerQuery.set(query, queryPage + 1);
          const rand = seeded(`${platform}|${query}|${queryPage}`);
          const items = [];
          for (let i = 0; i < 14; i += 1) {
            const id = crypto.createHash('sha1').update(`${platform}|${query}|${queryPage}|${i}`).digest('hex').slice(0, 12);
            const productLike = Boolean(productImage) && i % 2 === 0;
            items.push({
              platformId: `synthetic-${id}`,
              url: null,
              thumbnailBuffer: productLike ? await productThumbnail(productImage, rand) : await abstractThumbnail(rand),
              caption: `[DEMO] Synthetic ${platform} record ${page * 14 + i + 1} for "${query}" (${productLike ? 'derived from the product photo' : 'unrelated pattern'}). Not a real video.`,
              author: 'demo-data',
              publishedAt: new Date(Date.UTC(2026, 9, 1) - (page * 14 + i) * 86_400_000).toISOString(),
              isDemo: true,
              extra: { demo: true },
            });
          }
          // Deliberate repeats so dedup has something to remove: one exact ID repeat and one re-encoded image.
          if (previousId) items.push({ ...items[1], platformId: previousId });
          items.push({ ...items[0], platformId: `${items[0].platformId}-reupload`, thumbnailBuffer: await sharp(items[0].thumbnailBuffer).jpeg({ quality: 60 }).toBuffer() });
          previousId = items[2].platformId;
          page += 1;
          return { items, done: page >= 8, label: `demo "${query}" page ${page}` };
        },
      };
    },
  };
}
