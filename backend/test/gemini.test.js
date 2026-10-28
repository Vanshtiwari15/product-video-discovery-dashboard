import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGeminiError, geminiJson, keyKind, rankDiscoveredModels, resetGeminiState } from '../src/brain/gemini.js';
import sharp from 'sharp';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGeminiState(config.vision);
});

const config = {
  vision: { geminiKey: 'test-key', geminiModel: 'test-model' },
};
const logger = { info() {}, warn() {} };
const success = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

test('Gemini retries a transient request rate limit and returns the successful response', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Requests per minute rate limit exceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '0.01' },
    });
    return success();
  };

  assert.deepEqual(await geminiJson({ config, logger, prompt: 'test', label: 'gemini-test' }), { ok: true });
  assert.equal(calls, 2);
});

test('Gemini does not retry exhausted daily/project quota', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: {
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota, please check your plan and billing details.',
    } }), { status: 429, headers: { 'content-type': 'application/json' } });
  };

  await assert.rejects(geminiJson({ config, logger, prompt: 'test' }), (error) => {
    assert.equal(error.code, 'GEMINI_QUOTA_EXHAUSTED');
    assert.equal(error.retryable, false);
    assert.match(error.message, /quota is exhausted/);
    return true;
  });
  assert.equal(calls, 1);
});

test('Gemini billing and invalid model errors are actionable and not retried', async () => {
  for (const scenario of [
    { status: 403, body: { error: { message: 'Billing account is not enabled for this project.' } }, code: 'GEMINI_BILLING_REQUIRED' },
    { status: 400, body: { error: { message: 'models/not-a-model is not found.' } }, code: 'GEMINI_INVALID_REQUEST' },
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(scenario.body), { status: scenario.status, headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(geminiJson({ config, logger, prompt: 'test' }), (error) => {
      assert.equal(error.code, scenario.code);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Gemini sends a valid image with structured, low-latency generation settings', async () => {
  let request;
  const imageConfig = { vision: { ...config.vision, geminiModel: 'gemini-3.8-flash' } };
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return success();
  };
  const image = await sharp({ create: { width: 1700, height: 900, channels: 3, background: '#c65b84' } }).png().toBuffer();
  const result = await geminiJson({
    config: imageConfig,
    logger,
    prompt: 'Extract visible product details as JSON.',
    images: [{ label: 'Product reference image:', buffer: image }],
  });

  assert.deepEqual(result, { ok: true });
  assert.match(request.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(request.url.includes('test-key'), false, 'credential is not embedded in request URL');
  assert.equal(request.headers['x-goog-api-key'], 'test-key');
  assert.equal(request.body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  const resized = await sharp(Buffer.from(request.body.contents[0].parts[1].inline_data.data, 'base64')).metadata();
  assert.equal(resized.width, 1600, 'large images are resized before inline submission');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.body.generationConfig.maxOutputTokens, 4096, 'room for thinking tokens plus a 10-candidate verdict array');
  assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('Gemini 404 reports an unavailable model without retrying', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'models/unknown is not found for API version v1beta' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  await assert.rejects(geminiJson({ config, logger, prompt: 'test' }), (error) => {
    assert.equal(error.code, 'GEMINI_MODEL_UNAVAILABLE');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('Gemini timeout is classified, measured, and retried only within the configured bound', async () => {
  let calls = 0;
  const timeoutConfig = { vision: { ...config.vision, geminiTimeoutMs: 15, geminiRetries: 0 } };
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'TimeoutError')), { once: true });
      setTimeout(() => reject(new Error('mock transport did not complete')), 100);
    });
  };
  await assert.rejects(geminiJson({ config: timeoutConfig, logger, prompt: 'test' }), (error) => {
    assert.equal(error.code, 'GEMINI_TIMEOUT');
    assert.match(error.message, /timed out after \d+ ms using test-model/);
    return true;
  });
  assert.equal(calls, 1);
});

test('Gemini malformed responses are reported explicitly', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not JSON' }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(geminiJson({ config, logger, prompt: 'test' }), (error) => error.code === 'GEMINI_MALFORMED_RESPONSE');
});
test('an invalid API key is reported as an auth problem and the other Google endpoint is tried', async () => {
  const urls = [];
  const authConfig = { vision: { geminiKey: 'AQ.example-key', geminiModel: 'gemini-3.5-flash-lite' } };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(geminiJson({ config: authConfig, logger, prompt: 'test' }), (error) => {
    assert.equal(error.code, 'GEMINI_AUTH');
    assert.match(error.message, /aistudio\.google\.com\/apikey/);
    return true;
  });
  assert.equal(urls.length, 2, 'one attempt per endpoint, no retries');
  assert.match(urls[0], /aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-3\.5-flash-lite:generateContent/, 'AQ. keys try Vertex AI express first');
  assert.match(urls[1], /generativelanguage\.googleapis\.com/);
});

test('a Vertex-style key that works on Vertex is remembered for later calls', async () => {
  const urls = [];
  const vertexConfig = { vision: { geminiKey: 'AQ.example-key', geminiModel: 'gemini-3.5-flash-lite' } };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return success();
  };
  await geminiJson({ config: vertexConfig, logger, prompt: 'one' });
  await geminiJson({ config: vertexConfig, logger, prompt: 'two' });
  assert.ok(urls.every((url) => url.includes('aiplatform.googleapis.com')));
  resetGeminiState(vertexConfig.vision);
});

test('quota exhaustion on one model falls through to the next model in the chain', async () => {
  const models = [];
  const chainConfig = { vision: { geminiKey: 'AIza-test', geminiModel: 'gemini-3.5-flash-lite', geminiFallbackModels: ['gemini-3.8-flash'] } };
  globalThis.fetch = async (url) => {
    const model = /models\/([^:]+):/.exec(String(url))[1];
    models.push(model);
    if (model === 'gemini-3.5-flash-lite') {
      return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 per day' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return success();
  };
  assert.deepEqual(await geminiJson({ config: chainConfig, logger, prompt: 'test' }), { ok: true });
  assert.deepEqual(models, ['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  models.length = 0;
  await geminiJson({ config: chainConfig, logger, prompt: 'again' });
  assert.deepEqual(models, ['gemini-3.8-flash'], 'the exhausted model is skipped until its quota resets');
  resetGeminiState(chainConfig.vision);
});

test('a per-minute free-tier limit is a short rate limit, not daily exhaustion', () => {
  const minute = classifyGeminiError({ status: 429, data: { error: { message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 15 per minute', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } } });
  assert.equal(minute.code, 'GEMINI_RATE_LIMIT');
  assert.equal(minute.retryable, true);
  assert.equal(minute.retryAfterMs, 7000);
  const day = classifyGeminiError({ status: 429, data: { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 PerDay' } } });
  assert.equal(day.code, 'GEMINI_QUOTA_EXHAUSTED');
});

test('a truncated JSON answer is retried once with a larger output budget', async () => {
  const budgets = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.generationConfig.maxOutputTokens);
    if (budgets.length === 1) return new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '[{"candidate":1,' }] } }] }), { status: 200 });
    return success();
  };
  assert.deepEqual(await geminiJson({ config, logger, prompt: 'test', maxOutputTokens: 1000 }), { ok: true });
  assert.deepEqual(budgets, [1000, 2000]);
});

test('key format detection and model discovery ranking', () => {
  assert.equal(keyKind('AIzaSyExample'), 'aistudio');
  assert.equal(keyKind('AQ.Ab8Example'), 'vertex');
  const ranked = rankDiscoveredModels([
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.9-flash-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
  ]);
  assert.deepEqual(ranked, ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.9-flash-preview']);
});
