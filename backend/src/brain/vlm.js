import { geminiJson } from './gemini.js';
import { openaiCompatJson } from './openaiCompat.js';
import { claudeJson, imageBlock } from './anthropic.js';

// Errors after which a provider is skipped for the rest of the search (they will not recover in minutes).
const DEFINITIVE = /QUOTA|BILLING|AUTH|PERMISSION|MODEL_UNAVAILABLE|INVALID_REQUEST/;

// Ordered list of the vision-language providers this configuration can use. Gemini first (free tier),
// then an optional OpenAI-compatible free endpoint, then Claude only if a key is set (paid; not configured by default).
export function createVlm({ config, logger }) {
  const { vision } = config;
  const providers = [];
  if (vision.geminiKey) providers.push({ id: 'gemini', label: 'Gemini', maxImages: 16, call: (args) => geminiJson({ config, logger, ...args }) });
  if (vision.fallbackVlm?.baseUrl && vision.fallbackVlm?.apiKey && vision.fallbackVlm?.model) {
    providers.push({ id: 'fallback', label: vision.fallbackVlm.model, maxImages: Math.max(2, vision.fallbackVlm.maxImages || 5), call: (args) => openaiCompatJson({ config, logger, ...args }) });
  }
  if (vision.anthropicKey) {
    providers.push({
      id: 'claude', label: 'Claude', maxImages: 20,
      call: ({ prompt, images, label, onUsage }) => {
        const content = [];
        for (const item of images) {
          if (item.label) content.push({ type: 'text', text: item.label });
          content.push(imageBlock(item.buffer));
        }
        content.push({ type: 'text', text: prompt });
        return claudeJson({ config, logger, content, maxTokens: 2000, label, onUsage, system: 'You verify products in ecommerce images and video frames. Respond with JSON only.' });
      },
    });
  }
  const disabled = new Map();

  const active = () => providers.filter((p) => !disabled.has(p.id));
  return {
    get configured() { return providers.length > 0; },
    get available() { return active().length > 0; },
    get label() { return active()[0]?.label ?? providers[0]?.label ?? 'VLM'; },
    get names() { return providers.map((p) => p.label); },
    // Largest number of images the current provider accepts in one request.
    maxImages() { return active()[0]?.maxImages ?? 0; },
    disabledReasons() { return [...disabled.entries()].map(([id, reason]) => `${id}: ${reason}`); },
    // Tries providers in order; a definitive failure (quota, auth) disables that provider for this VLM instance.
    async json({ prompt, images, label, onUsage, imagesFor }) {
      let lastError = null;
      for (const provider of active()) {
        const list = imagesFor ? imagesFor(provider.maxImages) : images;
        try {
          const result = await provider.call({ prompt, images: list, label: `${provider.id}-${label}`, onUsage });
          return { result, provider: provider.label, used: list.length };
        } catch (error) {
          lastError = error;
          logger?.warn({ provider: provider.id, code: error.code, err: error.message?.slice(0, 200) }, 'vision-language provider failed');
          // Quota/auth problems disable the provider for this search; transient ones only skip it for this call.
          if (DEFINITIVE.test(error.code || '')) disabled.set(provider.id, error.message?.slice(0, 160) || error.code);
        }
      }
      throw lastError ?? new Error('No vision-language provider is configured');
    },
  };
}
