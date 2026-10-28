import 'dotenv/config';
import path from 'node:path';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const float = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes'].includes(String(value).toLowerCase());

const list = (value, fallback = []) => (value === undefined || value === '' ? fallback : String(value).split(',').map((v) => v.trim()).filter(Boolean));

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  port: int(process.env.PORT, 4000),
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'pvd.sqlite'),
  mediaDir: path.join(dataDir, 'media'),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Never mixed with real results: when true, both sources are replaced by the synthetic demo adapter.
  demoMode: bool(process.env.DEMO_MODE, false),

  minPerSource: int(process.env.MIN_RESULTS_PER_SOURCE, 20),
  maxRoundsPerSource: int(process.env.MAX_ROUNDS_PER_SOURCE, 16),
  maxRetryableErrors: int(process.env.MAX_RETRYABLE_ERRORS, 3),
  sourceTimeoutMs: int(process.env.SOURCE_TIMEOUT_MS, 300_000),
  instagramSourceTimeoutMs: int(process.env.INSTAGRAM_SOURCE_TIMEOUT_MS, Math.max(int(process.env.SOURCE_TIMEOUT_MS, 600_000), 600_000)),
  metaSourceTimeoutMs: int(process.env.META_SOURCE_TIMEOUT_MS, Math.max(int(process.env.SOURCE_TIMEOUT_MS, 480_000), 480_000)),
  // Free-tier guard: stop asking a provider for more items once this many have been fetched for one source in one search.
  maxProviderItemsPerSource: int(process.env.MAX_PROVIDER_ITEMS_PER_SOURCE, 450),
  // 'auto': branded searches need the exact product (or a colour/size variant); generic ones accept the product category.
  matchScope: (process.env.MATCH_SCOPE || 'auto').toLowerCase(),
  requestRetries: int(process.env.REQUEST_RETRIES, 2),
  jobConcurrency: int(process.env.JOB_CONCURRENCY, 2),
  productCacheTtlHours: int(process.env.PRODUCT_CACHE_TTL_HOURS, 24),
  analysisFailureCacheMs: int(process.env.ANALYSIS_FAILURE_CACHE_MS, 300_000),

  apify: {
    token: process.env.APIFY_TOKEN || '',
    instagramActor: process.env.APIFY_INSTAGRAM_ACTOR || 'apify~instagram-hashtag-scraper',
    metaActor: process.env.APIFY_META_ACTOR || 'apify~facebook-ads-scraper',
    // Reels from the brand's own Instagram account (only used when a verified handle is known).
    instagramReelActor: process.env.APIFY_INSTAGRAM_REEL_ACTOR || 'apify~instagram-reel-scraper',
    instagramBrandReels: bool(process.env.INSTAGRAM_BRAND_REELS, true),
    hashtagsPerRun: int(process.env.INSTAGRAM_HASHTAGS_PER_RUN, 4),
    metaQueriesPerRound: int(process.env.META_QUERIES_PER_ROUND, 2),
    runTimeoutSecs: int(process.env.APIFY_RUN_TIMEOUT_SECS, 180),
    dumpRaw: bool(process.env.APIFY_DUMP_RAW, false),
    baseUrl: process.env.APIFY_API_BASE || 'https://api.apify.com/v2',
  },

  meta: {
    provider: (process.env.META_PROVIDER || 'apify').toLowerCase(), // 'apify' | 'graph'
    graphToken: process.env.META_ACCESS_TOKEN || '',
    graphVersion: process.env.META_GRAPH_VERSION || 'v23.0',
    countries: (process.env.META_AD_COUNTRIES || 'ALL').split(',').map((c) => c.trim()).filter(Boolean),
  },

  frames: {
    enabled: bool(process.env.FRAME_SAMPLING, true),
    ffmpegPath: process.env.FFMPEG_PATH || '',
    count: int(process.env.FRAME_COUNT, 5),
    everySeconds: int(process.env.FRAME_EVERY_SECONDS, 3),
    maxVideoBytes: int(process.env.FRAME_MAX_VIDEO_MB, 40) * 1024 * 1024,
    maxPerBatch: int(process.env.FRAME_MAX_PER_BATCH, 8),
    confidentAbove: float(process.env.FRAME_CONFIDENT_ABOVE, 0.85),
  },

  vision: {
    backend: (process.env.VISION_BACKEND || 'clip').toLowerCase(), // 'clip' | 'basic'
    clipModel: process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    geminiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    // Free-tier quotas are per model, so a quota-exhausted or retired model falls through to the next one.
    geminiFallbackModels: list(process.env.GEMINI_FALLBACK_MODELS, []),
    // Ask the Models API (free, no generation quota) which Flash models this key can use, and add them to the chain.
    geminiDiscoverModels: bool(process.env.GEMINI_DISCOVER_MODELS, true),
    // auto | aistudio | vertex. AI Studio keys start with "AIza"; Google Cloud / Vertex AI express keys often start with "AQ.".
    geminiEndpoint: (process.env.GEMINI_ENDPOINT || 'auto').toLowerCase(),
    geminiMaxOutputTokens: int(process.env.GEMINI_MAX_OUTPUT_TOKENS, 4096),
    // Optional second free verifier with an OpenAI-compatible API (for example Groq's free tier), used when Gemini is unavailable.
    fallbackVlm: {
      baseUrl: (process.env.VLM_FALLBACK_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: process.env.VLM_FALLBACK_API_KEY || '',
      model: process.env.VLM_FALLBACK_MODEL || '',
      maxImages: int(process.env.VLM_FALLBACK_MAX_IMAGES, 5),
    },
    // Hard cap on verification calls per search, so one search cannot spend a whole day of free quota.
    vlmMaxCallsPerSearch: int(process.env.VLM_MAX_CALLS_PER_SEARCH, 12),
    // Candidates below this local relevance (0..1) are never sent to the verifier.
    vlmSendFloor: float(process.env.VLM_SEND_FLOOR, 0.3),
    geminiTimeoutMs: Math.max(10_000, Math.min(int(process.env.GEMINI_TIMEOUT_MS, 35_000), 90_000)),
    geminiRetries: Math.max(0, Math.min(int(process.env.GEMINI_REQUEST_RETRIES, 1), 2)),
    verifyWithVlm: bool(process.env.VLM_VERIFY, true),
    vlmBatchSize: int(process.env.VLM_BATCH_SIZE, 10),
    // 'ambiguous': only candidates whose visual score is inside the band go to the configured VLM. 'all': everything above the low edge.
    vlmMode: (process.env.VLM_MODE || 'ambiguous').toLowerCase(),
    vlmBand: [float(process.env.VLM_BAND_LOW, 0.2), float(process.env.VLM_BAND_HIGH, 0.9)],
    matchThreshold: int(process.env.MATCH_THRESHOLD, 55),
    nearDuplicateDistance: int(process.env.NEAR_DUPLICATE_HAMMING, 8),
    nearDuplicateMinColour: float(process.env.NEAR_DUPLICATE_MIN_COLOUR, 0.9),
    // Cosine ranges mapped linearly to 0..1. Tuned on the test products; see README.
    // Calibrated on 316 real Instagram/Meta candidates: true matches have multi-crop cosine ~0.64-0.76, unrelated videos ~0.48-0.65.
    clipImageRange: [float(process.env.CLIP_IMAGE_COS_LOW, 0.5), float(process.env.CLIP_IMAGE_COS_HIGH, 0.78)],
    clipTextRange: [float(process.env.CLIP_TEXT_COS_LOW, 0.2), float(process.env.CLIP_TEXT_COS_HIGH, 0.31)],
  },
};

