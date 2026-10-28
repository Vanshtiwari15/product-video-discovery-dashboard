import sharp from 'sharp';
import { requestJson } from '../http/apiClient.js';
import { parseJsonLoose } from './anthropic.js';
import { SourceError } from '../errors.js';

// Any OpenAI-compatible chat-completions endpoint with image input (e.g. Groq's free tier).
// Images are sent as small JPEG data URLs; most free endpoints cap images per request (VLM_FALLBACK_MAX_IMAGES).
export async function openaiCompatJson({ config, logger, prompt, images = [], label = 'fallback-vlm', onUsage }) {
  const { baseUrl, apiKey, model } = config.vision.fallbackVlm || {};
  if (!baseUrl || !apiKey || !model) throw new Error('VLM fallback is not configured');
  const content = [];
  for (const item of images) {
    if (item.label) content.push({ type: 'text', text: item.label });
    const jpeg = await sharp(item.buffer).resize(768, 768, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
  }
  content.push({ type: 'text', text: `${prompt}\nRespond with JSON only.` });
  const data = await requestJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: { model, temperature: 0, max_tokens: 2048, messages: [{ role: 'user', content }] },
    timeoutMs: 60_000,
    retries: 1,
    label,
    logger,
    classifyError: ({ status, detail }) => {
      if (status === 401 || status === 403) return { code: 'VLM_FALLBACK_AUTH', retryable: false, message: `${label}: credential rejected (${detail})` };
      if (status === 429 && /day|daily|quota/i.test(detail)) return { code: 'VLM_FALLBACK_QUOTA', retryable: false, message: `${label}: daily quota exhausted (${detail})` };
      return null;
    },
  });
  onUsage?.({ input_tokens: data?.usage?.prompt_tokens || 0, output_tokens: data?.usage?.completion_tokens || 0 });
  const text = data?.choices?.[0]?.message?.content || '';
  try {
    return parseJsonLoose(text);
  } catch {
    throw new SourceError('VLM_FALLBACK_MALFORMED', `${label}: response was not valid JSON`);
  }
}
