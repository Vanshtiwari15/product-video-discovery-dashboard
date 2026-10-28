// Live relevance check against your running backend (uses your real .env: Apify, Gemini).
// Usage (backend running on :4000):
//   node scripts/live-check.mjs "Stanley Quencher H2.0 40 oz tumbler" --image path/to/photo.jpg
//   node scripts/live-check.mjs "tumbler"
// Writes evaluation/live-check-<time>.html: every accepted Instagram Reel and Meta ad with its thumbnail, score,
// verified/unverified flag and the verifier's reason, so relevance can be checked by eye. It never judges for you.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > -1 ? args.splice(i, 2)[1] : null; };
const image = opt('image');
const base = opt('base') || 'http://localhost:4000';
const query = args.join(' ').trim();
if (!query) {
  console.error('Usage: node scripts/live-check.mjs "<product name or URL>" [--image photo.jpg] [--base http://localhost:4000]');
  process.exit(1);
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const health = await (await fetch(`${base}/api/health`)).json().catch(() => null);
if (!health) throw new Error(`Backend not reachable at ${base}. Start it with "npm run dev" in backend/.`);
console.log(`Backend: threshold ${health.threshold}, verification ${health.vision?.verification ? 'on' : 'OFF'}, demo ${health.demoMode}`);
if (health.threshold !== 55) console.warn(`! MATCH_THRESHOLD is ${health.threshold}, not 55 — check backend/.env`);
if (!health.vision?.verification) console.warn('! VLM_VERIFY is off or no Gemini key: results are unverified');

const form = new FormData();
form.set('query', query);
if (image) form.set('image', new Blob([fs.readFileSync(image)], { type: /\.png$/i.test(image) ? 'image/png' : /\.webp$/i.test(image) ? 'image/webp' : 'image/jpeg' }), path.basename(image));
const started = await (await fetch(`${base}/api/search`, { method: 'POST', body: form })).json();
if (!started.id) throw new Error(started.error?.message || 'search was not created');
const t0 = Date.now();
let data;
for (;;) {
  data = await (await fetch(`${base}/api/search/${started.id}`)).json();
  if (!['queued', 'running'].includes(data.search.status)) break;
  const p = data.search.summary || {};
  process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s ${data.search.stage || ''}            `);
  await new Promise((r) => setTimeout(r, 4000));
}
console.log('');
const s = data.search.summary || {};
const plan = data.product?.searchPlan || {};
const rows = [];
const sections = [];
for (const platform of ['instagram', 'meta']) {
  const stats = s[platform] || {};
  const accepted = (data.results?.[platform] || []).filter((v) => v.matchStatus === 'accepted' && !v.previouslySeen).sort((a, b) => b.score - a.score);
  const verified = accepted.filter((v) => v.explanation?.verified).length;
  rows.push({ platform, relevant: `${accepted.length}/${s.instagram?.target || 20}`, verified, unverified: accepted.length - verified, fetched: stats.fetched, duplicates: (stats.duplicates || 0) + (stats.nearDuplicates || 0), rejected: stats.lowMatch, apifyUsd: stats.providerCostUsd, status: stats.status });
  sections.push(`<h2>${platform === 'meta' ? 'Meta Ad Library' : 'Instagram Reels'}: ${accepted.length} relevant (${verified} verified)</h2><div class="grid">${accepted.map((v, i) => `
    <div class="card"><a href="${esc(v.url)}" target="_blank"><img src="${v.thumbnailUrl ? esc(base + v.thumbnailUrl) : ''}" alt=""></a>
    <div class="meta"><b>#${i + 1} · ${v.score}</b> <span class="${v.explanation?.verified ? 'ok' : 'warn'}">${v.explanation?.verified ? 'verified' : 'unverified'}</span><br>
    ${esc(v.explanation?.summary)}<br><small>${esc(v.author)} · ${esc((v.caption || '').slice(0, 140))}</small><br>
    <small>found by ${esc(v.foundBy)}</small><br><label>Relevant? <input type="checkbox"></label></div></div>`).join('')}</div>`);
}
console.table(rows);
for (const note of s.notes || []) console.log(`- ${note}`);
console.log(`Status ${data.search.status} in ${Math.round((s.durationMs || 0) / 1000)} s · ${s.scoringMethod} · verifier calls ${s.usage?.vlmCalls ?? 0}`);

const outDir = path.resolve('..', 'evaluation');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `live-check-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Live check: ${esc(query)}</title>
<style>body{font:14px system-ui;margin:24px;color:#222}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.card{border:1px solid #ddd;border-radius:8px;overflow:hidden}.card img{width:100%;aspect-ratio:9/14;object-fit:cover;background:#eee}.meta{padding:8px}
.ok{color:#1e7a4f}.warn{color:#a15c00}code{background:#f3f3f3;padding:1px 4px}</style>
<h1>Live check: ${esc(query)}</h1>
<p>Status <b>${esc(data.search.status)}</b> · scope <b>${esc(plan.scope)}</b> · threshold ${esc(s.threshold)} · ${esc(s.scoringMethod)} · ${Math.round((s.durationMs || 0) / 1000)} s</p>
<p>Hashtags: ${(plan.hashtags || []).map((h) => `<code>#${esc(h)}</code>`).join(' ')} · Meta queries: ${(plan.queries || []).map((q) => `<code>${esc(q)}</code>`).join(' ')}${plan.accounts?.length ? ` · accounts: ${plan.accounts.map((a) => `<code>@${esc(a)}</code>`).join(' ')}` : ''}</p>
<ul>${(s.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
${sections.join('')}
<p><small>Tick "Relevant?" while reviewing; the script does not judge relevance itself.</small></p>`);
console.log(`Report: ${file}`);
