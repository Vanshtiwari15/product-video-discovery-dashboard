import sharp from 'sharp';
import { requestJson } from '../http/apiClient.js';
import { parseJsonLoose } from './anthropic.js';
import { SourceError } from '../errors.js';

const AISTUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VERTEX_BASE = 'https://aiplatform.googleapis.com/v1';
const ENDPOINT_NAMES = { aistudio: 'Google AI Studio (generativelanguage.googleapis.com)', vertex: 'Vertex AI express (aiplatform.googleapis.com)' };

// Process-wide memory per configuration: which endpoint accepted the key, which models the key can use,
// and which models are temporarily out of free quota. Keyed by the config.vision object so each test config is isolated.
const states = new WeakMap();
function stateFor(vision) {
  let state = states.get(vision);
  if (!state) {
    state = { endpoint: null, discovery: null, blocked: new Map() };
    states.set(vision, state);
  }
  return state;
}
export function resetGeminiState(vision) {
  if (vision) states.delete(vision);
}

// AI Studio keys start with "AIza". Keys bound to Google Cloud service accounts (Vertex AI express mode) start with "AQ.".
export function keyKind(key) {
  if (/^AIza/.test(key)) return 'aistudio';
  if (/^AQ\./.test(key)) return 'vertex';
  return 'unknown';
}

function parseRetryDelayMs(error) {
  const info = (error?.details || []).find((d) => String(d['@type'] || '').includes('RetryInfo'));
  const match = /^(\d+(?:\.\d+)?)s$/.exec(info?.retryDelay || '');
  if (match) return Math.round(Number(match[1]) * 1000);
  const text = /retry in (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(error?.message || '');
  if (!text) return null;
  return Math.round(((Number(text[1] || 0) * 60 + Number(text[2] || 0)) * 60 + Number(text[3])) * 1000);
}

export function classifyGeminiError({ status, data, detail }) {
  const error = data?.error || {};
  const reasons = (error.details || []).map((d) => d.reason).filter(Boolean);
  const text = `${detail || error.message || ''} ${error.status || ''} ${JSON.stringify(error.details || [])}`.toLowerCase();
  const message = String(detail || error.message || 'Provider rejected the request');
  const retryAfterMs = parseRetryDelayMs(error);

  const badKey = reasons.includes('API_KEY_INVALID') || /api key not valid|api_key_invalid|api keys are not supported|unregistered callers|invalid authentication credentials|api key expired/.test(text);
  if (badKey || status === 401) {
    return { code: 'GEMINI_AUTH', retryable: false, message: `Gemini rejected the API key. Provider message: ${message}` };
  }
  const billing = /billing|payment|paid plan|billing account/.test(text);
  const perMinute = /per.?minute|perminute|rpm|tokens per minute/.test(text);
  const exhausted = /per.?day|perday|daily|limit: ?0\b/.test(text) || (/current quota|quota exceeded|free.?tier/.test(text) && !perMinute);
  if (status === 429 && exhausted) {
    return { code: 'GEMINI_QUOTA_EXHAUSTED', retryable: false, retryAfterMs, message: `Gemini quota is exhausted for this model; no retry was attempted. Free-tier quotas are per model and reset daily. Provider message: ${message}` };
  }
  if (status >= 400 && status < 500 && billing) {
    return { code: 'GEMINI_BILLING_REQUIRED', retryable: false, message: `Gemini billing is not available for this project; no retry was attempted. Provider message: ${message}` };
  }
  if (status === 403) {
    return { code: 'GEMINI_PERMISSION_DENIED', retryable: false, message: `Gemini rejected this project's permission or API configuration (is the API enabled for this key's project?). Provider message: ${message}` };
  }
  if (status === 404) {
    return { code: 'GEMINI_MODEL_UNAVAILABLE', retryable: false, message: `Gemini model is unavailable to this key or does not support generateContent. Provider message: ${message}` };
  }
  if (status === 400) {
    const modelProblem = /model|not found|not supported/.test(text);
    const thinkingProblem = /thinking/.test(text);
    return { code: thinkingProblem ? 'GEMINI_THINKING_UNSUPPORTED' : modelProblem ? 'GEMINI_INVALID_REQUEST' : 'GEMINI_INVALID_REQUEST', modelProblem, retryable: false, message: `Gemini rejected the request or model configuration. Provider message: ${message}` };
  }
  if (status === 429) {
    // Short waits are retried in place; long ones move on to the next model instead of stalling the search.
    const longWait = retryAfterMs !== null && retryAfterMs > 20_000;
    return { code: 'GEMINI_RATE_LIMIT', retryable: !longWait, retryAfterMs: longWait ? null : retryAfterMs, blockMs: longWait ? retryAfterMs : null, message: `Gemini request rate limit reached. Provider message: ${message}` };
  }
  return { retryable: status >= 500 };
}

async function prepareImage(buffer) {
  const image = sharp(buffer, { failOn: 'error' });
  const metadata = await image.metadata();
  const mimeType = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heif', gif: 'image/gif', avif: 'image/avif' })[metadata.format];
  if (!mimeType) throw new SourceError('GEMINI_INVALID_IMAGE', `Unsupported Gemini image format: ${metadata.format || 'unknown'}`);
  if (buffer.length <= 2_000_000 && Math.max(metadata.width || 0, metadata.height || 0) <= 1600) {
    return { buffer, mimeType };
  }
  const optimized = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  if (optimized.length > 2_000_000) throw new SourceError('GEMINI_IMAGE_TOO_LARGE', 'Gemini image could not be reduced below the 2 MB inline limit');
  return { buffer: optimized, mimeType: 'image/jpeg' };
}

export function thinkingConfigFor(model) {
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  // 2.5 Flash / Flash-Lite accept a zero thinking budget; Pro models do not.
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  return null;
}

// Orders discovered models: stable before preview, newest first, Flash-Lite before Flash (more free quota).
export function rankDiscoveredModels(models) {
  const version = (name) => Number((/gemini-(\d+(?:\.\d+)?)/.exec(name) || [])[1] || 0);
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((name) => /^gemini-\d/.test(name) && /flash/.test(name))
    .filter((name) => !/image|tts|audio|live|embedding|exp|native|computer|robotics|thinking|8b/.test(name))
    .sort((a, b) => (/preview/.test(a) - /preview/.test(b)) || (version(b) - version(a)) || (/lite/.test(b) - /lite/.test(a)))
    .slice(0, 4);
}

async function discoverModels({ key, logger }) {
  try {
    const data = await requestJson(`${AISTUDIO_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, timeoutMs: 15_000, retries: 1, label: 'gemini-models', classifyError: classifyGeminiError });
    const ranked = rankDiscoveredModels(data?.models || []);
    logger?.info({ models: ranked }, 'gemini models available to this key');
    return ranked;
  } catch (error) {
    logger?.warn({ code: error.code, err: error.message }, 'gemini model discovery failed; using configured models only');
    return [];
  }
}

function endpointOrder(vision, state) {
  if (vision.geminiEndpoint === 'aistudio' || vision.geminiEndpoint === 'vertex') return [vision.geminiEndpoint];
  if (state.endpoint) return [state.endpoint];
  return keyKind(vision.geminiKey) === 'vertex' ? ['vertex', 'aistudio'] : ['aistudio', 'vertex'];
}

async function modelChain({ vision, state, logger }) {
  const configured = [vision.geminiModel, ...(vision.geminiFallbackModels || [])].filter(Boolean);
  let discovered = [];
  const order = endpointOrder(vision, state);
  if (vision.geminiDiscoverModels && order[0] === 'aistudio') {
    state.discovery ??= discoverModels({ key: vision.geminiKey, logger });
    discovered = await state.discovery;
  }
  const chain = [...new Set([...configured, ...discovered])];
  const now = Date.now();
  return chain.filter((model) => {
    const block = state.blocked.get(model);
    return !block || block.until <= now;
  });
}

function requestUrl(endpoint, model, key) {
  return endpoint === 'vertex'
    ? `${VERTEX_BASE}/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
    : `${AISTUDIO_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}

const FALL_THROUGH = new Set(['GEMINI_QUOTA_EXHAUSTED', 'GEMINI_MODEL_UNAVAILABLE', 'GEMINI_RATE_LIMIT']);
const ENDPOINT_PROBLEMS = new Set(['GEMINI_AUTH', 'GEMINI_PERMISSION_DENIED']);

export async function geminiJson({ config, logger, prompt, images = [], label = 'gemini-vlm', onUsage, maxOutputTokens }) {
  const vision = config.vision;
  const key = vision.geminiKey;
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  const state = stateFor(vision);

  const parts = [];
  for (const item of images) {
    if (item.label) parts.push({ text: item.label });
    const prepared = await prepareImage(item.buffer);
    parts.push({ inline_data: { mime_type: prepared.mimeType, data: prepared.buffer.toString('base64') } });
  }
  parts.push({ text: prompt });

  const chain = await modelChain({ vision, state, logger });
  if (!chain.length) {
    const blocks = [...state.blocked.values()];
    const last = blocks[blocks.length - 1];
    throw new SourceError(last?.code || 'GEMINI_QUOTA_EXHAUSTED', `${label}: every configured Gemini model is temporarily unavailable (${last?.message?.slice(0, 160) || 'quota exhausted'})`, { retryable: false });
  }

  let lastError;
  for (const model of chain) {
    try {
      return await callModel({ model, vision, state, logger, parts, label, onUsage, maxOutputTokens });
    } catch (error) {
      lastError = error;
      if (!FALL_THROUGH.has(error.code) && !(error.code === 'GEMINI_INVALID_REQUEST' && error.modelProblem)) throw error;
      const blockMs = error.code === 'GEMINI_RATE_LIMIT' ? (error.blockMs || 60_000)
        : error.code === 'GEMINI_QUOTA_EXHAUSTED' ? Math.max(error.retryAfterMs || 0, 60 * 60_000)
          : 24 * 60 * 60_000;
      state.blocked.set(model, { until: Date.now() + blockMs, code: error.code, message: error.message });
      logger?.warn({ label, model, code: error.code, nextModel: chain[chain.indexOf(model) + 1] || null }, 'gemini model unavailable, trying the next model');
    }
  }
  throw lastError;
}

async function callModel({ model, vision, state, logger, parts, label, onUsage, maxOutputTokens }) {
  const endpoints = endpointOrder(vision, state);
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const result = await generate({ endpoint, model, vision, logger, parts, label, onUsage, maxOutputTokens });
      state.endpoint ??= endpoint;
      return result;
    } catch (error) {
      lastError = error;
      if (!ENDPOINT_PROBLEMS.has(error.code)) throw error;
    }
  }
  if (ENDPOINT_PROBLEMS.has(lastError?.code) && endpoints.length > 1) {
    lastError.message = `Gemini rejected GEMINI_API_KEY on both ${ENDPOINT_NAMES.aistudio} and ${ENDPOINT_NAMES.vertex}. `
      + 'Create a free key at https://aistudio.google.com/apikey (it starts with "AIza"), put it in backend/.env and restart the backend. '
      + `Last provider message: ${lastError.message}`;
  }
  throw lastError;
}

async function generate({ endpoint, model, vision, logger, parts, label, onUsage, maxOutputTokens }) {
  let thinking = thinkingConfigFor(model);
  let budget = maxOutputTokens ?? vision.geminiMaxOutputTokens ?? 4096;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = Date.now();
    let data;
    try {
      data = await requestJson(requestUrl(endpoint, model, vision.geminiKey), {
        method: 'POST',
        headers: endpoint === 'aistudio' ? { 'x-goog-api-key': vision.geminiKey } : {},
        body: {
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: budget, temperature: 0, ...(thinking ? { thinkingConfig: thinking } : {}) },
        },
        timeoutMs: vision.geminiTimeoutMs ?? 35_000,
        retries: vision.geminiRetries ?? 1,
        label,
        classifyError: classifyGeminiError,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error.code === 'GEMINI_THINKING_UNSUPPORTED' && thinking) {
        thinking = null;
        continue;
      }
      if (error.code === 'TIMEOUT') {
        error.code = 'GEMINI_TIMEOUT';
        error.message = `${label}: timed out after ${durationMs} ms using ${model}; check network/provider latency or lower image resolution`;
      } else if (error.code === 'NETWORK') {
        error.code = 'GEMINI_NETWORK';
      }
      logger?.warn({ label, model, endpoint, durationMs, code: error.code || 'ERROR', status: error.status, retryable: Boolean(error.retryable) }, 'gemini request failed');
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    if (data?.usageMetadata) {
      onUsage?.({ input_tokens: data.usageMetadata.promptTokenCount || 0, output_tokens: data.usageMetadata.candidatesTokenCount || 0 });
    }
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (data?.promptFeedback?.blockReason) {
      throw new SourceError('GEMINI_BLOCKED', `${label}: Gemini blocked the request (${data.promptFeedback.blockReason})`);
    }
    try {
      if (!text) throw new Error('empty');
      const parsed = parseJsonLoose(text);
      logger?.info({ label, model, endpoint, durationMs, usage: data?.usageMetadata }, 'gemini call');
      return parsed;
    } catch {
      // Thinking tokens count against the output budget; a truncated answer gets one retry with a larger budget.
      if (candidate?.finishReason === 'MAX_TOKENS' && budget < 16_384) {
        budget *= 2;
        continue;
      }
      const error = new SourceError('GEMINI_MALFORMED_RESPONSE', `${label}: Gemini ${text ? 'response was not valid JSON' : 'returned no text candidate'}${candidate?.finishReason ? ` (finish reason ${candidate.finishReason})` : ''}`);
      logger?.warn({ label, model, durationMs, code: error.code }, 'gemini response invalid');
      throw error;
    }
  }
  throw new SourceError('GEMINI_MALFORMED_RESPONSE', `${label}: Gemini response was truncated repeatedly`);
}
