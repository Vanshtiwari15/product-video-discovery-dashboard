# Verification status by rubric area

**VERIFIED**: a test or measurement in this repo shows it working.
**PARTIALLY VERIFIED**: the logic is verified against fakes, fixtures or the fallback path, but not against the real external service or model.
**NOT VERIFIED**: not yet exercised.

The saved sandbox evidence predates the current local Windows run. Backend tests use fake HTTP/Apify/Gemini services. A single live Gemini image test was also run with the project key, but it does not prove future quota availability. Evidence files are in `evaluation/`.

## 1. Video sourcing (25)

| Requirement | Implementation | Test performed | Evidence | Status | Remaining risk |
|--|--|--|--|--|--|
| 20 Instagram Reels per search | Apify `instagram-hashtag-scraper`, hashtag rounds from the search plan | None against the live actor | – | NOT VERIFIED | Hashtag pages behind login walls, or few Reels for niche products |
| 20 Meta video ads per search | Apify `facebook-ads-scraper` with an Ad Library URL (`media_type=video`) | None against the live actor | – | NOT VERIFIED | Output field names; few video ads for small brands |
| Actor input matches the real schema | Schema read from the actor's latest build (free); field names chosen from it | Fake Apify server; `verify:sources --schema` against the fake | `test/apify.test.js` | PARTIALLY VERIFIED | Real schemas not yet read: run `--schema` |
| Response fields normalised (ID, URL, caption, thumbnail, video, date) | Normalisers accept camelCase and snake_case; non-video items rejected | Unit tests on documented shapes; probe against the fake | `test/apify.test.js` | PARTIALLY VERIFIED | Real field coverage unknown until `--probe` |
| Thumbnails | SSRF-safe download, decoded and cached locally (CDN links expire) | Probe against the fake downloaded real Shopify CDN images | probe smoke log | PARTIALLY VERIFIED | Instagram/Facebook CDN access not tested |
| Pagination / top-up | Rounds move from specific to broad queries; repeat searches rotate the plan; `maxItems` caps results | Top-up unit test; repeat searches in demo mode | `test/pipeline.test.js`, E2E | VERIFIED (logic) | Scrapers cannot page past the top posts per hashtag |
| Timeouts, retries, rate limits | Bounded exponential retries, `Retry-After`; source-specific limits; async runs keep partial results and are aborted by source deadline | Local HTTP server and fake Apify | `test/pipeline.test.js`, `test/apify.test.js` | VERIFIED (against fakes) | Live actor timing/availability remains provider-dependent |
| Gemini quota handling | Transient 429 retries; exhausted quota, billing, permissions and invalid model errors do not retry; fallback is cached briefly and verification opens a per-search circuit breaker | Mocked Gemini HTTP responses; prior saved run showed the free-tier daily quota error | `test/gemini.test.js`, `test/pipeline.test.js`, `test/vlm.test.js` | VERIFIED (logic against fakes) | Project's future quota/billing remains owner-dependent |
| Meta empty vs failure | Successful empty dataset is `no_matches`; auth, malformed response and actor errors remain failures | Fake Apify + Graph API | `test/apify.test.js` | VERIFIED (against fakes) | Commercial ad availability depends on the configured provider and jurisdiction |
| One source failing doesn't break the other | Sources run in parallel; each reports its own error | API test with Instagram returning 401 | `test/api.test.js` | VERIFIED | – |
| Shortfall shown, not hidden | Per-source summary and UI notice with a breakdown | API test, E2E | `test/api.test.js`, `evaluation/e2e-dashboard-sandbox.txt` | VERIFIED | – |
| Mock data never counted as real | `DEMO_MODE` replaces both sources; `is_demo` flag, `demo:` key prefix, banner and badges | API test (`isDemo`), E2E (banner) | as above | VERIFIED | – |
| Cost control | `maxItems` per run, Apify-reported cost and Claude tokens recorded per search and shown in the UI | Fake-server test (`maxItems` passed, usage read) | `test/apify.test.js` | PARTIALLY VERIFIED | Real `usageTotalUsd` reporting unconfirmed |

## 2. Image-analysis brain (25)

| Requirement | Implementation | Test performed | Evidence | Status | Remaining risk |
|--|--|--|--|--|--|
| CLIP loads and embeds images | transformers.js, `Xenova/clip-vit-base-patch32` (q8), image and text towers | `npm run verify:clip` written; the sandbox could not download the model, and the fallback was reported correctly | `/api/health` fallback reason | NOT VERIFIED | Model download on your network; onnxruntime on Windows |
| Product attributes | Gemini/Claude structured vision analysis when available; local CLIP zero-shot and centre-colour fallback; missing attributes remain unknown | Live Gemini test on saved Stanley image returned tumbler, pink/white, cylindrical, stainless steel, visible winged-bear logo and readable `STANLEY` text in 3.3 s | `scripts/verify-gemini-image.mjs`; `test/gemini.test.js`; `test/pipeline.test.js` | VERIFIED (one live image) | OCR/logo accuracy varies with image clarity; Gemini 3.8 Flash timed out at about 46 s on this environment |
| Improved queries and hashtags | Attribute, title, brand and category queries plus title broadening; never colour-only | Unit tests | `test/score.test.js` | VERIFIED | Query quality depends on attribute quality |
| Compare video frames | ffmpeg samples 5 frames (1 every 3 s) of non-confident candidates and keeps the best; the frame is shown in the UI | Real ffmpeg on a generated video where the product appears only at 3–6 s: score rose by more than 30 and the 3 s frame was chosen | `test/frames.test.js` | VERIFIED (local video) | Live CDN video downloads not tested |
| 0–100 score with evidence | Visual = 0.8 × CLIP + 0.2 × colour; with Claude, 0.35 × visual + 0.65 × verdict; explanations carry the formula and components | Unit tests, Claude stub test, E2E "Why this score" | `test/vlm.test.js`, `test/score.test.js` | VERIFIED | – |
| Gemini/Claude verifier for ambiguous candidates | Visual score inside configured band → batched provider call; records skips, failures, usage; stops repeated requests after a definitive quota/config error | Stubbed `fetch`: request shape, band routing, quota, 401 handling | `test/gemini.test.js`, `test/vlm.test.js` | PARTIALLY VERIFIED | Live image analysis verified, but no live video-match verification was made |
| Exact vs similar vs unrelated evaluation | `npm run benchmark:brain` on a public Shopify demo catalogue (other photos of the same board vs other boards in the same kind of scene vs wax) | Run in the sandbox with the basic fallback only | `evaluation/brain-benchmark-basic.md`: exact mean 49, similar 61, unrelated 39, top-1 3/8 | PARTIALLY VERIFIED | Shows the fallback cannot judge exact products; CLIP and Claude runs pending |
| Documented threshold | 55, configurable; the benchmark reports the best threshold for each backend | Benchmark | as above | PARTIALLY VERIFIED | Not calibrated on CLIP or Claude yet |

## 3. Uniqueness and de-duplication (15)

| Requirement | Implementation | Test performed | Evidence | Status | Remaining risk |
|--|--|--|--|--|--|
| No duplicates within a result set | Platform ID or normalised-URL key | Unit and API tests (unique keys) | `test/dedup.test.js`, `test/api.test.js` | VERIFIED | – |
| Near-duplicates (re-uploads) | Hash distance ≤ 8 and colour overlap ≥ 0.90 | Unit test; real-photo measurement | Re-encodes 7/7, small crops 6/7, false positives 0/21 (README) | VERIFIED (photos) | Heavy crops and mirrored videos are missed |
| Same ad under several IDs | Ad Library collation ID, or page plus ad copy | Unit test | `test/dedup.test.js` | VERIFIED (logic) | – |
| New results across searches | `seen_videos` (key and fingerprint) | API, top-up and E2E tests | `test/api.test.js`, `test/pipeline.test.js` | VERIFIED | – |
| Top-up after dedup | Collector continues until 20 new or the plan is exhausted | Unit test (stops at target, reports shortfall) | `test/pipeline.test.js` | VERIFIED | – |
| "Show previously seen" toggle | Old matches stored with `previouslySeen`, revealed by the toggle | E2E: repeat search, toggle reveals "Seen before" cards | `evaluation/e2e-dashboard-sandbox.txt` | VERIFIED | – |

## 4. Backend design (15)

| Requirement | Implementation | Test performed | Evidence | Status | Remaining risk |
|--|--|--|--|--|--|
| REST routes and structured errors | Express; `{error: {code, message}}` | API tests (400, 404, upload, SSRF) | `test/api.test.js` | VERIFIED | – |
| SSE progress | In-memory hub plus `/events` | API test (replay); E2E (live timeline) | as above | VERIFIED | – |
| Background jobs | In-process queue with concurrency 2; `interrupted` status on restart | API tests (202, then poll) | `test/api.test.js` | PARTIALLY VERIFIED | Restart marking not tested; single instance only |
| Caching | Product page (24 h TTL), image analysis (per image and model), thumbnails on disk | Unit test | `test/pipeline.test.js` | VERIFIED | – |
| Parallel sources | `Promise.all` over functions that never throw | API test | `test/api.test.js` | VERIFIED | – |
| Security | SSRF guard (static checks, every redirect, connect-time DNS); upload checks; secrets only in `.env` | 20 blocked-URL cases, DNS block, API and E2E | `test/urlSafety.test.js` | VERIFIED | – |
| Persistence | SQLite (WAL) | DB reopen test | `test/api.test.js` | VERIFIED | – |
| Test suite | Prior sandbox log has 44 tests; current local Windows backend suite has 63/63; frontend stage mapper has 3/3 and Vite build succeeds | `npm test`; `node --test src/components/stageStatus.test.js`; `npm run build` | Local run | VERIFIED (local fakes/build) | Browser E2E and live video providers not tested here |

## 5. React dashboard (10)

| Requirement | Implementation | Test performed | Evidence | Status | Remaining risk |
|--|--|--|--|--|--|
| Source tabs with live counts against 20 | Tabs plus counts, refreshed while running | E2E (count = visible cards, All = sum) | `evaluation/e2e-dashboard-sandbox.txt` | VERIFIED (demo data) | – |
| Progress | 5-step timeline from SSE | E2E | as above | VERIFIED | – |
| Video cards | Thumbnail, platform, link, caption, score meter with threshold, reasons, matched frame | E2E, screenshots | as above | VERIFIED | Real links not exercised |
| Filters and sorting | Score slider, date window, newest or best, below-threshold, previously seen, CSV export | E2E (min score, sort order, toggles) | as above | VERIFIED | – |
| History | Sidebar list with status and counts | E2E | as above | VERIFIED | – |
| Loading, error, partial, empty states | Notices for each | E2E (unsafe URL error, shortfall); API | as above | VERIFIED | – |
| Responsive | Breakpoints at 1100 px and 720 px | Screenshots at 1440 and 820 px | – | VERIFIED (visual) | – |

## 6. Documentation and demo (10)

| Requirement | Implementation | Test performed | Evidence | Status | Remaining risk |
|--|--|--|--|--|--|
| README and `.env.example` | Setup (Windows), architecture, API, sources, brain, dedup, security, tests, limitations | Reviewed | `README.md` | VERIFIED | – |
| Five-product evidence | `npm run evaluate` writes `evaluation/results.md` with counts and borderline examples for manual verdicts | Script run in demo mode | README table (demo data) | NOT VERIFIED (real data) | Needs paid runs |
| 3–5 minute demo | Checklist in README | – | – | NOT VERIFIED | Needs real-data searches |

## Relevance fix (October 2026)

Root causes, the changes and the offline measurements on real, hand-labelled candidates are in the README "Status" section.
Reproduce offline: `node scripts/replay-eval.mjs --pool ../evaluation/real-candidates-stanley.json --image data/media/products/f3e8a13af5752a7abee91ed3faa0638d.jpg --title "Stanley Quencher H2.0 40 oz tumbler" --old scripts/lib/original-score.js` (needs the cached thumbnails in `backend/data/media`).
Live evidence: `node scripts/live-check.mjs "<product>" --image <photo>` writes `evaluation/live-check-*.html` for manual review.
