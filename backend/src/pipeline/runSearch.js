import crypto from 'node:crypto';
import path from 'node:path';
import { safeFetch } from '../http/safeFetch.js';
import { extractProduct, keywordsFromUrl, urlHash } from '../product/extract.js';
import { normalizeImage, saveMedia } from '../brain/imageUtils.js';
import { createScorer } from '../brain/score.js';
import { createFrameSampler } from '../brain/frames.js';
import { collectFromSource, emptyStats } from './collect.js';
import { createDedupState } from './dedup.js';
import { createDemoSources } from '../sources/index.js';

// Repeat searches for the same product start from queries that earlier searches used last,
// because provider scrapers return the same top posts for the same hashtag and cannot paginate past them.
export function rotatePlan(plan, timesSearched) {
  const rotate = (list = [], step) => (list.length ? [...list.slice(step % list.length), ...list.slice(0, step % list.length)] : list);
  return { ...plan, queries: rotate(plan.queries, timesSearched), hashtags: rotate(plan.hashtags, timesSearched * 2) };
}

// Plain-language reason a platform ended below target, built only from recorded counts.
export function explainShortfall(platformLabel, stats, target) {
  if (stats.accepted >= target) return null;
  const parts = [`${platformLabel}: ${stats.accepted}/${target} relevant videos.`];
  if (stats.status === 'not_configured') return `${platformLabel}: not configured (${stats.error}).`;
  parts.push(`${stats.fetched} candidates fetched (${stats.duplicates + stats.nearDuplicates} duplicates, ${stats.previouslySeen} shown in earlier searches, ${stats.lowMatch} not relevant or not confirmed).`);
  if (stats.error) parts.push(`Stopped early: ${stats.error}`);
  else if (stats.warnings.some((w) => /free-tier budget/.test(w))) parts.push('Stopped at the per-search provider item budget to stay inside the free tier.');
  else parts.push('Every planned query/hashtag was tried; no more relevant public videos were returned for them.');
  parts.push('Results are not padded with unrelated videos.');
  return parts.join(' ');
}

const shortHash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

async function storeProductImage(buffer, mediaDir) {
  const normalized = await normalizeImage(buffer);
  const { hash } = await saveMedia(path.join(mediaDir, 'products'), normalized);
  return { buffer: normalized, hash };
}

export function createSearchRunner({ repo, sources, analyzeProduct, embedder, progress, config, logger }) {
  async function resolveProduct(searchId, input) {
    const warnings = [];
    let title = input.value;
    let description = null;
    let imageUrl = null;
    let brand = null;
    let category = null;
    let extraction = 'keyword';

    if (input.inputType === 'url') {
      progress.stage(searchId, 'product', { status: 'active', message: 'Fetching product page' });
      try {
        const page = await extractProduct(input.value, { repo, config, logger });
        ({ title, description, imageUrl, brand, category } = page);
        extraction = `${page.method}${page.cached ? ' (cached)' : ''}`;
      } catch (error) {
        const fallback = keywordsFromUrl(input.value);
        if (!input.upload && fallback.split(' ').length < 2) {
          throw new Error(`Could not read the product page (${error.message}). Search by product name or upload the product photo.`);
        }
        title = fallback || 'Uploaded product';
        extraction = 'url-words-fallback';
        warnings.push(`Product page could not be read (${error.message}). Using words from the URL ("${fallback}")${input.upload ? ' and the uploaded photo' : ''}.`);
      }
    } else {
      progress.stage(searchId, 'product', { status: 'active', message: 'Using keyword input' });
    }

    let image = null;
    if (input.upload) {
      image = await storeProductImage(input.upload.buffer, config.mediaDir);
      extraction += ' + uploaded photo';
    } else if (imageUrl) {
      try {
        const { body } = await safeFetch(imageUrl, { accept: 'image/*', maxBytes: 8_000_000 });
        image = await storeProductImage(body, config.mediaDir);
      } catch (error) {
        warnings.push(`Product image could not be downloaded (${error.message}); scoring falls back to text.`);
      }
    }

    const id = input.inputType === 'url' ? `url:${urlHash(input.value).slice(0, 24)}${image && input.upload ? `:${image.hash.slice(0, 8)}` : ''}` : `kw:${shortHash(input.value.toLowerCase())}:${image?.hash.slice(0, 12) || 'noimg'}`;
    progress.stage(searchId, 'product', { status: warnings.length ? 'partial' : 'completed', message: `${title?.slice(0, 80) || 'Product resolved'}${warnings.length ? ' (with warnings)' : ''}` });
    return { id, sourceUrl: input.inputType === 'url' ? input.value : null, title, description, imageUrl, brand, category, imageBuffer: image?.buffer ?? null, imageHash: image?.hash ?? null, extraction, warnings };
  }

  async function runSource(searchId, source, ctx) {
    const stage = source.platform;
    if (!source.isConfigured()) {
      const stats = { ...emptyStats(config.minPerSource), status: 'not_configured', error: source.notConfiguredMessage, retryPossible: false };
      progress.stage(searchId, stage, { status: 'skipped', message: source.notConfiguredMessage, stats });
      return stats;
    }
    const controller = new AbortController();
    const timeoutMs = config[`${stage}SourceTimeoutMs`] ?? config.sourceTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error('source timeout')), timeoutMs);
    progress.stage(searchId, stage, { status: 'active', message: `Searching ${source.label}` });
    try {
      const stats = await collectFromSource({
        source,
        searchPlan: ctx.searchPlan,
        searchId,
        dedup: ctx.dedup,
        scoreBatch: ctx.scoreBatch,
        repo,
        config,
        signal: controller.signal,
        onProgress: (live) => {
          progress.stage(searchId, stage, { status: 'active', message: live.message, stats: live });
        },
      });
      if (controller.signal.aborted) {
        stats.error = `${source.label} exceeded its ${timeoutMs / 1000}s source timeout; collected results were retained.`;
        stats.errorCode = 'SOURCE_TIMEOUT';
        stats.retryPossible = true;
        stats.warnings.push(stats.error);
        stats.status = stats.accepted > 0 || stats.fetched > 0 ? 'short' : 'failed';
      }
      let progressStatus;
      if (stats.status === 'ok') progressStatus = 'completed';
      else if (stats.status === 'not_configured') progressStatus = 'skipped';
      else if (stats.status === 'failed') progressStatus = 'failed';
      else if (stats.error) progressStatus = stats.accepted > 0 ? 'partial' : 'failed';
      else if (stats.accepted > 0) progressStatus = 'partial';
      else progressStatus = 'no_matches';
        const message = stats.error
          ? `${stats.accepted} accepted; ${stats.fetched} fetched. ${stats.error} Retry possible: ${stats.retryPossible ? 'yes' : 'no'}.`
          : stats.status === 'ok'
            ? `${stats.accepted} accepted; target of ${config.minPerSource} met. ${stats.fetched} candidates fetched.`
            : stats.accepted === 0
              ? `No matching videos found. ${stats.fetched} candidates collected across ${stats.rounds} rounds.`
              : `${stats.accepted} accepted of ${config.minPerSource} target; ${stats.fetched} candidates fetched.`;
      progress.stage(searchId, stage, { status: progressStatus, message, stats });
      return stats;
    } catch (error) {
      logger.error({ searchId, source: stage, code: error.code, err: error.message }, 'source failed');
      const retryPossible = Boolean(error.retryable || ['ABORTED', 'TIMEOUT', 'SOURCE_TIMEOUT'].includes(error.code));
      const stats = { ...emptyStats(config.minPerSource), status: 'failed', error: error.message, errorCode: error.code || 'ERROR', retryPossible };
      progress.stage(searchId, stage, { status: 'failed', message: `${error.message} Retry possible: ${retryPossible ? 'yes' : 'no'}.`, stats });
      return stats;
    } finally {
      clearTimeout(timer);
    }
  }

  return async function runSearch(searchId, input) {
    const log = logger.child({ searchId });
    const started = Date.now();
    let currentStage = 'product';
    repo.updateSearch(searchId, { status: 'running', stage: 'product' });
    try {
      const product = await resolveProduct(searchId, input);

      currentStage = 'analysis';
      repo.updateSearch(searchId, { stage: 'analysis' });
      progress.stage(searchId, 'analysis', { status: 'active', message: product.imageBuffer ? 'Analysing product image' : 'No image: analysing title' });
      const analysis = await analyzeProduct(product);
      const warnings = [...product.warnings, ...analysis.warnings];
      repo.saveProduct({ ...product, attributes: { ...analysis.attributes, brand: product.brand, pageCategory: product.category, extraction: product.extraction, warnings }, queries: analysis.searchPlan, analysisMethod: analysis.method });
      repo.updateSearch(searchId, { productId: product.id, stage: 'sources' });
      currentStage = 'scoring';
      progress.stage(searchId, 'analysis', {
        status: analysis.status === 'partial' ? 'partial' : 'completed',
        message: `${analysis.method}${analysis.cached ? ' (cached)' : ''}${analysis.status === 'partial' ? ' (some attributes unavailable)' : ''} · ${analysis.searchPlan.queries.length} queries`,
      });

      const frameSampler = config.frames.enabled && !config.demoMode ? createFrameSampler({ config }) : null;
      const scoreBatch = createScorer({ embedder, config, logger: log, frameSampler, product: { ...product, attributes: analysis.attributes, searchPlan: analysis.searchPlan } });
      const dedup = createDedupState({ seen: repo.loadSeen(), nearDistance: config.vision.nearDuplicateDistance, minColourOverlap: config.vision.nearDuplicateMinColour });
      const scoringMethod = `${await embedder.method()}${frameSampler ? ' + frame sampling' : ''} · ${scoreBatch.describe()}`;
      progress.stage(searchId, 'scoring', { status: 'active', message: `Scoring with ${scoringMethod}` });

      const timesSearched = repo.countPriorSearches(product.id, searchId);
      const ctx = { searchPlan: rotatePlan(analysis.searchPlan, timesSearched), dedup, scoreBatch };
      const active = config.demoMode ? createDemoSources(product.imageBuffer) : sources;
      // runSource never throws: each source reports its own failure, so one cannot break the other.
      const [instagram, meta] = await Promise.all([runSource(searchId, active.instagram, ctx), runSource(searchId, active.meta, ctx)]);

      const summary = {
        instagram, meta, scoringMethod, threshold: config.vision.matchThreshold, scope: analysis.searchPlan.scope,
        usage: { ...scoreBatch.usage, analysisMethod: analysis.method }, durationMs: Date.now() - started,
      };
      const both = [instagram, meta];
      const allMet = both.every((s) => s.accepted >= config.minPerSource);
      const fetchedAny = both.some((s) => s.fetched > 0);
      const completedWithoutMatches = both.some((s) => ['short', 'not_configured'].includes(s.status) && !s.error);
      const status = allMet ? 'complete' : fetchedAny || completedWithoutMatches ? 'partial' : 'failed';
      const notes = [];
      if (both.some((s) => s.unscored > 0)) {
        notes.push(product.imageBuffer ? 'Some videos had no usable thumbnail and could not be checked visually.' : 'No product photo was available and CLIP text matching was unavailable, so videos could not be scored. Upload a product photo or enable CLIP.');
      }
      for (const [label, stats] of [['Instagram', instagram], ['Meta', meta]]) {
        const reason = explainShortfall(label, stats, config.minPerSource);
        if (reason) notes.push(reason);
        if (stats.unverifiedAccepted > 0) notes.push(`${label}: ${stats.unverifiedAccepted} accepted video(s) were not checked by a vision-language model (verifier unavailable or budget used); they passed on local image + caption evidence only.`);
      }
      summary.notes = notes;
      const error = status === 'failed' ? both.map((s) => s.error).filter(Boolean).join(' | ') || 'Neither source returned any videos for these queries' : null;

      const scoringPartial = scoreBatch.usage.vlmFailures > 0 || instagram.unverifiedAccepted + meta.unverifiedAccepted > 0;
      progress.stage(searchId, 'scoring', {
        status: scoringPartial ? 'partial' : 'completed',
        message: `${instagram.accepted + meta.accepted} relevant at threshold ${config.vision.matchThreshold} (${analysis.searchPlan.scope} match); ${scoreBatch.usage.vlmVerified} candidates verified in ${scoreBatch.usage.vlmCalls} calls${scoreBatch.usage.vlmFailures ? `; verification failed for ${scoreBatch.usage.vlmFailures}` : ''}.`,
      });
      repo.updateSearch(searchId, { status, stage: 'done', sourceSummary: summary, error, finished: true });
      progress.finish(searchId, status);
      log.info({ status, instagram: instagram.accepted, meta: meta.accepted, ms: summary.durationMs }, 'search finished');
    } catch (error) {
      log.error({ err: error.message }, 'search failed');
      repo.updateSearch(searchId, { status: 'failed', stage: 'done', error: error.message, finished: true });
      progress.stage(searchId, currentStage, { status: 'failed', message: error.message });
      progress.finish(searchId, 'failed');
    }
  };
}

