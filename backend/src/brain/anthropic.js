import { requestJson } from '../http/apiClient.js';

export const imageBlock = (jpegBuffer) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: jpegBuffer.toString('base64') },
});

export function parseJsonLoose(text) {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.search(/[[{]/);
  const end = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
  if (start === -1 || end === -1) throw new Error('Model response contained no JSON');
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function claudeJson({ config, logger, system, content, maxTokens = 1200, label, onUsage }) {
  const data = await requestJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.vision.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: { model: config.vision.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] },
    timeoutMs: 90_000,
    retries: 2,
    label,
    logger,
  });
  onUsage?.(data?.usage);
  logger?.info({ label, model: config.vision.anthropicModel, usage: data?.usage }, 'claude call');
  const text = (data?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  return parseJsonLoose(text);
}
