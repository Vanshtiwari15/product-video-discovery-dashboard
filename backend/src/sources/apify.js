import fs from 'node:fs/promises';
import path from 'node:path';
import { requestJson } from '../http/apiClient.js';
import { SourceError } from '../errors.js';

const apiBase = (config) => config.apify.baseUrl || 'https://api.apify.com/v2';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const schemaCache = new Map();
const auth = (config) => ({ authorization: `Bearer ${config.apify.token}` });

// Reads the actor's input schema from its latest build (free: no actor run), so input field names are
// checked against the real schema instead of assumed. Returns null if the schema cannot be read.
export async function getActorInputSchema(actorId, { config, logger }) {
  if (schemaCache.has(actorId)) return schemaCache.get(actorId);
  let schema = null;
  try {
    const actor = await requestJson(`${apiBase(config)}/acts/${encodeURIComponent(actorId)}`, { headers: auth(config), label: 'apify-actor', logger, retries: 1 });
    const buildId = actor?.data?.taggedBuilds?.latest?.buildId;
    if (buildId) {
      const build = await requestJson(`${apiBase(config)}/actor-builds/${buildId}`, { headers: auth(config), label: 'apify-build', logger, retries: 1 });
      const raw = build?.data?.inputSchema ?? build?.data?.actorDefinition?.input ?? null;
      schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
  } catch (error) {
    logger?.warn({ actorId, err: error.message }, 'actor input schema unavailable, using default field names');
  }
  schemaCache.set(actorId, schema);
  return schema;
}

// First candidate that exists in the schema; with no schema, the first (documented) name.
export function pickField(schema, candidates) {
  const properties = schema?.properties;
  if (!properties) return candidates[0];
  return candidates.find((name) => Object.hasOwn(properties, name)) ?? null;
}

// Starts a run, polls until it ends, then reads the dataset. Unlike run-sync, this keeps partial results
// from runs that time out, and aborts the run (stopping billing) when our own source timeout fires.
// maxItems caps how many results a pay-per-result actor can charge for.
export async function runActor(actorId, input, { config, signal, logger, label, maxItems }) {
  const params = new URLSearchParams({ timeout: String(config.apify.runTimeoutSecs) });
  if (maxItems) params.set('maxItems', String(maxItems));
  const started = await requestJson(`${apiBase(config)}/acts/${encodeURIComponent(actorId)}/runs?${params}`, {
    // Keep creation alive until we receive the run ID; otherwise cancellation can hide an already-created run.
    method: 'POST', headers: auth(config), body: input, label, logger, retries: 1,
  });
  let run = started?.data;
  if (!run?.id) throw new SourceError('BAD_RESPONSE', `${label}: Apify did not create a run`);

  const abortRun = () =>
    requestJson(`${apiBase(config)}/actor-runs/${run.id}/abort`, { method: 'POST', headers: auth(config), label: `${label}-abort`, retries: 0 }).catch(() => {});
  if (signal?.aborted) {
    await abortRun();
    throw new SourceError('ABORTED', `${label}: aborted`);
  }
  signal?.addEventListener('abort', abortRun, { once: true });
  try {
    while (!TERMINAL.has(run.status)) {
      const polled = await requestJson(`${apiBase(config)}/actor-runs/${run.id}?waitForFinish=60`, { headers: auth(config), signal, label, logger, timeoutMs: 80_000 });
      run = polled.data;
    }
  } finally {
    signal?.removeEventListener('abort', abortRun);
  }

  const items = await requestJson(`${apiBase(config)}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, { headers: auth(config), signal, label, logger });
  if (!Array.isArray(items)) throw new SourceError('BAD_RESPONSE', `${label}: dataset is not an array`);
  if (config.apify.dumpRaw) {
    const dir = path.join(config.dataDir, 'raw');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${label}-${run.id}.json`), JSON.stringify({ actorId, input, run: { id: run.id, status: run.status }, items }, null, 2));
  }
  if (run.status !== 'SUCCEEDED' && items.length === 0) {
    throw new SourceError(`RUN_${run.status.replace(/-/g, '_')}`, `${label}: actor run ${run.status.toLowerCase()} with no results${run.statusMessage ? ` (${run.statusMessage})` : ''}`, {
      // TIMED-OUT and ABORTED (by our own timeout) are worth retrying on the next round.
      retryable: run.status === 'TIMED-OUT' || run.status === 'ABORTED',
    });
  }
  return { items, run: { id: run.id, status: run.status, usageUsd: run.usageTotalUsd ?? null, itemCount: items.length } };
}

// Actors report per-input failures (blocked hashtag, login wall) as items with an "error" field.
export function splitErrors(items) {
  const errors = items.filter((item) => item && item.error).map((item) => `${item.error}${item.errorDescription ? `: ${item.errorDescription}` : ''}`);
  return { items: items.filter((item) => item && !item.error), errors: [...new Set(errors)].slice(0, 3) };
}
