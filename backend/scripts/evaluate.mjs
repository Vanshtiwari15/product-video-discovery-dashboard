// Runs each product in a JSON file against a running backend and writes evaluation/results.md.
// Usage: node scripts/evaluate.mjs ../evaluation/products.json [http://localhost:4000]
// Good/bad match labels are left for manual review: the script lists candidates, it does not judge them.
import fs from 'node:fs';
import path from 'node:path';

const [file = '../evaluation/products.json', base = 'http://localhost:4000'] = process.argv.slice(2);
const products = JSON.parse(fs.readFileSync(file, 'utf8'));
const outFile = path.resolve(path.dirname(file), 'results.md');

async function run(product) {
  const form = new FormData();
  form.set('query', product.query);
  if (product.image) {
    const imagePath = path.resolve(path.dirname(file), '..', product.image);
    form.set('image', new Blob([fs.readFileSync(imagePath)], { type: imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg' }), path.basename(imagePath));
  }
  const started = await (await fetch(`${base}/api/search`, { method: 'POST', body: form })).json();
  if (!started.id) throw new Error(started.error?.message || 'search was not created');
  for (;;) {
    const data = await (await fetch(`${base}/api/search/${started.id}`)).json();
    if (!['queued', 'running'].includes(data.search.status)) return data;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const line = (v) => `${v.score} | ${v.platform} | ${(v.explanation?.summary || '').replace(/\|/g, '/')} | ${v.url || 'synthetic'} | ___`;
const sections = [];
const rows = [];

for (const product of products) {
  process.stdout.write(`Running ${product.name}… `);
  try {
    const data = await run(product);
    const s = data.search.summary || {};
    const fresh = (src) => data.results[src].filter((v) => v.matchStatus === 'accepted' && !v.previouslySeen);
    const all = [...data.results.instagram, ...data.results.meta].filter((v) => v.score !== null && !v.previouslySeen);
    const accepted = all.filter((v) => v.matchStatus === 'accepted').sort((a, b) => b.score - a.score);
    const rejected = all.filter((v) => v.matchStatus === 'low_match').sort((a, b) => b.score - a.score);
    rows.push(`| ${product.name} | ${data.search.status}${data.search.isDemo ? ' (DEMO DATA)' : ''} | ${fresh('instagram').length} | ${fresh('meta').length} | ${s.instagram?.fetched ?? 0} / ${s.meta?.fetched ?? 0} | ${(s.instagram?.duplicates ?? 0) + (s.instagram?.nearDuplicates ?? 0) + (s.meta?.duplicates ?? 0) + (s.meta?.nearDuplicates ?? 0)} | ${s.scoringMethod || '-'} | ${Math.round((s.durationMs || 0) / 1000)}s |`);
    sections.push(
      `### ${product.name}\n\nQuery: \`${product.query}\`  \nProduct: ${data.product?.title || '-'}  \nAnalysis: ${data.product?.analysisMethod || '-'}  \nErrors: ${[s.instagram?.error, s.meta?.error].filter(Boolean).join('; ') || 'none'}\n\n` +
        `Highest scored (check these are the exact product):\n\nScore | Source | Reason | Link | Manual verdict\n--|--|--|--|--\n${accepted.slice(0, 3).map(line).join('\n') || '- | - | none | - | -'}\n\n` +
        `Borderline accepted and best rejected (check the threshold):\n\nScore | Source | Reason | Link | Manual verdict\n--|--|--|--|--\n${[...accepted.slice(-2), ...rejected.slice(0, 2)].map(line).join('\n') || '- | - | none | - | -'}\n`,
    );
    console.log(`${data.search.status}: IG ${fresh('instagram').length}, Meta ${fresh('meta').length}`);
  } catch (error) {
    rows.push(`| ${product.name} | error: ${error.message} | - | - | - | - | - | - |`);
    console.log(`error: ${error.message}`);
  }
}

const report = `# Evaluation results\n\nGenerated ${new Date().toISOString()} against ${base}.\n\n| Product | Status | New IG matches | New Meta matches | Fetched IG / Meta | Duplicates removed | Scoring | Time |\n|--|--|--|--|--|--|--|--|\n${rows.join('\n')}\n\n${sections.join('\n')}`;
fs.writeFileSync(outFile, report);
console.log(`Wrote ${outFile}`);
