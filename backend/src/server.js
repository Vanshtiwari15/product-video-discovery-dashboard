import { config } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './db/index.js';
import { createRepo } from './db/repo.js';
import { createApp } from './app.js';
import { createEmbedder } from './brain/embedder.js';
import { createProductAnalyzer } from './brain/analyze.js';
import { createSources } from './sources/index.js';
import { createProgressHub } from './pipeline/progress.js';
import { createJobQueue } from './pipeline/jobQueue.js';
import { createSearchRunner } from './pipeline/runSearch.js';
import { keyKind } from './brain/gemini.js';

const db = openDatabase(config.dbPath);
const repo = createRepo(db);
const interrupted = repo.interruptRunningSearches();
if (interrupted) logger.warn({ interrupted }, 'marked unfinished searches as interrupted');

const embedder = createEmbedder({ config, logger });
const sources = createSources({ config, logger });
const progress = createProgressHub();
const queue = createJobQueue({ concurrency: config.jobConcurrency, logger });
const runSearch = createSearchRunner({ repo, sources, analyzeProduct: createProductAnalyzer({ embedder, repo, config, logger }), embedder, progress, config, logger });

const health = () => ({
  demoMode: config.demoMode,
  minPerSource: config.minPerSource,
  threshold: config.vision.matchThreshold,
  sources: {
    instagram: { configured: config.demoMode || sources.instagram.isConfigured(), provider: config.demoMode ? 'demo' : 'apify' },
    meta: { configured: config.demoMode || sources.meta.isConfigured(), provider: config.demoMode ? 'demo' : config.meta.provider },
  },
  vision: {
    backend: config.vision.backend,
    fallbackReason: embedder.fallbackReason,
    gemini: config.vision.geminiKey ? { model: config.vision.geminiModel, fallbackModels: config.vision.geminiFallbackModels, keyFormat: keyKind(config.vision.geminiKey), endpoint: config.vision.geminiEndpoint } : null,
    fallbackVlm: config.vision.fallbackVlm.model || null,
    claude: Boolean(config.vision.anthropicKey),
    verification: Boolean((config.vision.geminiKey || config.vision.fallbackVlm.apiKey || config.vision.anthropicKey) && config.vision.verifyWithVlm),
    matchScope: config.matchScope,
  },
  queue: queue.size,
});

if (config.vision.geminiKey && keyKind(config.vision.geminiKey) !== 'aistudio') {
  logger.warn({ keyFormat: keyKind(config.vision.geminiKey) }, 'GEMINI_API_KEY does not look like a Google AI Studio key (those start with "AIza"); the Vertex AI express endpoint will be tried as well');
}
if (config.vision.matchThreshold < 55) logger.warn({ threshold: config.vision.matchThreshold }, 'MATCH_THRESHOLD is below 55: weak matches will be accepted (set MATCH_THRESHOLD=55 in backend/.env)');
if (!config.vision.verifyWithVlm) logger.warn('VLM_VERIFY=false: results are accepted on local evidence only, which is much less precise for exact-product searches');

const app = createApp({ repo, queue, runSearch, progress, config, logger, health });
app.listen(config.port, () => {
  logger.info({ port: config.port, demoMode: config.demoMode, vision: config.vision.backend, claude: Boolean(config.vision.anthropicKey) }, 'server listening');
  // Load CLIP in the background so the first search does not pay the full model start-up.
  embedder.method().catch(() => {});
});
