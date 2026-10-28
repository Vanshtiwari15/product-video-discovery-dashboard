import sharp from 'sharp';
import { z } from 'zod';
import { colorHistogram, dominantColors, sha256 } from './imageUtils.js';
import { cosine } from './imageUtils.js';
import { buildSearchPlan as buildPlan } from './plan.js';
import { createVlm } from './vlm.js';

const PRODUCT_TYPES = [
  't-shirt', 'hoodie', 'dress', 'shirt', 'jacket', 'jeans', 'kurta', 'saree', 'sneakers', 'shoes', 'cap', 'handbag', 'backpack',
  'wristwatch', 'sunglasses', 'jewellery', 'tablecloth', 'cushion cover', 'bedsheet', 'towel', 'rug', 'curtain', 'mug', 'water bottle',
  'phone case', 'headphones', 'skincare bottle', 'lipstick', 'perfume bottle', 'chocolate bar', 'protein powder tub', 'snack packet',
  'supplement bottle', 'candle', 'notebook', 'lamp', 'plant pot', 'toy', 'kitchen appliance',
];
const PATTERNS = ['plain solid colour', 'floral print', 'hand block print', 'geometric pattern', 'stripes', 'checks', 'polka dots', 'graphic print', 'large text logo', 'animal print', 'paisley', 'tie-dye'];
const MATERIALS = ['cotton fabric', 'denim', 'leather', 'knitted wool', 'silk', 'plastic', 'glass', 'metal', 'wood', 'ceramic', 'paper packaging', 'rubber'];

const vlmSchema = z.object({
  product_type: z.string().nullish(),
  category: z.string().nullish(),
  colors: z.array(z.string()).default([]),
  print_or_graphic: z.string().nullish(),
  logos: z.array(z.string()).default([]),
  text_on_product: z.array(z.string()).default([]),
  material: z.string().nullish(),
  shape: z.string().nullish(),
  distinctive_features: z.array(z.string()).default([]),
  search_queries: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  brand: z.string().nullish(),
  model_name: z.string().nullish(),
  instagram_handles: z.array(z.string()).default([]),
});

const unique = (values) => [...new Set(values.map((v) => v?.trim()).filter(Boolean))];
const toHashtag = (text) => (text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function shortTitle(title) {
  return (title || '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(pack of \d+|set of \d+|\d+\s?(cm|mm|inch|in|ml|g|kg|pcs|x\d+))\b/gi, ' ')
    .replace(/[|,–—:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 7)
    .join(' ');
}

// Kept for callers/tests that pass (attributes, title, suggestions, page): the real logic lives in plan.js.
export function buildSearchPlan(attributes, title, suggestions = {}, page = {}, options = {}) {
  return buildPlan({ title, attributes, suggestions, page, scope: options.scope, fromVlm: Boolean(options.fromVlm) });
}

async function zeroShot(embedder, imageVector, labels) {
  const textVectors = await embedder.embedTexts(labels.map((label) => `a photo of ${label}`));
  if (!textVectors) return null;
  const logits = textVectors.map((vector) => 100 * cosine(imageVector, vector));
  const max = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - max));
  const total = exps.reduce((a, b) => a + b, 0);
  const ranked = labels.map((label, i) => ({ label, p: exps[i] / total })).sort((a, b) => b.p - a.p);
  return ranked[0].p >= 0.2 ? { label: ranked[0].label, confidence: Math.round(ranked[0].p * 100) / 100 } : null;
}

const ANALYSIS_PROMPT = ({ title, brand, category, description, hasImage }) => `Analyse this ecommerce product for a system that finds Instagram Reels and Facebook/Instagram video ads showing it.
What the user typed / product title (authoritative): ${title || 'unknown'}
Brand from the product page: ${brand || 'unknown'}
Category from the product page: ${category || 'unknown'}
Description: ${(description || 'none').slice(0, 800)}
${hasImage ? 'Use the attached product photo as primary visual evidence.' : 'No product photo is available; use text only.'}
Report only what is visible or stated. Read logos and on-product text only when legible. Use [] or null when unsure.
Return only JSON:
{"product_type": string|null, "category": string|null, "brand": string|null, "model_name": string|null, "colors": [string], "print_or_graphic": string|null, "logos": [string], "text_on_product": [string], "material": string|null, "shape": string|null, "distinctive_features": [string], "search_queries": [string], "hashtags": [string], "instagram_handles": [string]}
Rules:
- product_type: the plain noun a shopper uses (e.g. "tumbler", "serum", "tablecloth"), not a category like "kitchen appliance".
- brand / model_name: the brand and product line (e.g. "Stanley" / "Quencher H2.0"); null when not stated or legible.
- distinctive_features: visual details that separate THIS item from look-alikes (shape, logo position, lid, label layout, print).
- search_queries: 4 short phrases (max 4 words) advertisers would use in ad copy for this exact product, most specific first. No colours.
- hashtags: 6 real, commonly used Instagram hashtags for this product (lowercase, no #, max 20 characters, e.g. brand+model like "stanleyquencher"). No generic tags like "love" or colours.
- instagram_handles: the brand's official Instagram username(s) only if you are confident they exist; otherwise [].`;

async function analyzeWithVlm({ vlm, title, description, brand, category, imageBuffer }) {
  const images = imageBuffer ? [{ label: 'Product reference photo:', buffer: imageBuffer }] : [];
  const { result: raw, provider } = await vlm.json({ prompt: ANALYSIS_PROMPT({ title, brand, category, description, hasImage: Boolean(imageBuffer) }), images, label: 'analyse' });
  const parsed = vlmSchema.parse(raw);
  return {
    provider,
    attributes: {
      productType: parsed.product_type || null,
      category: parsed.category || null,
      colors: parsed.colors.map((c) => c.toLowerCase()),
      printOrGraphic: parsed.print_or_graphic || null,
      logos: parsed.logos,
      textOnProduct: parsed.text_on_product,
      material: parsed.material || null,
      shape: parsed.shape || null,
      distinctiveFeatures: parsed.distinctive_features,
    },
    suggestions: { queries: parsed.search_queries, hashtags: parsed.hashtags, brand: parsed.brand || null, modelName: parsed.model_name || null, instagramHandles: parsed.instagram_handles },
  };
}

async function analyzeLocally({ title, imageBuffer, embedder }) {
  const attributes = { productType: null, category: null, colors: [], printOrGraphic: null, logos: [], textOnProduct: [], material: null, shape: null, distinctiveFeatures: [] };
  const notes = ['Logos and on-product text need a vision-language model (set GEMINI_API_KEY or ANTHROPIC_API_KEY).'];
  if (!imageBuffer) return { attributes, suggestions: {}, notes: ['No product photo: attributes come from the title only.'] };

  // Centre 60% only: products are usually centred, and full-frame colours mostly measure the background.
  const meta = await sharp(imageBuffer).metadata();
  const centre = await sharp(imageBuffer)
    .extract({ left: Math.round(meta.width * 0.2), top: Math.round(meta.height * 0.2), width: Math.round(meta.width * 0.6), height: Math.round(meta.height * 0.6) })
    .toBuffer();
  attributes.colors = dominantColors(await colorHistogram(centre)).map((c) => c.name);
  const { kind, vector } = await embedder.embedImage(imageBuffer);
  if (kind === 'clip') {
    const [type, pattern, material] = await Promise.all([zeroShot(embedder, vector, PRODUCT_TYPES), zeroShot(embedder, vector, PATTERNS), zeroShot(embedder, vector, MATERIALS)]);
    attributes.productType = type?.label ?? null;
    attributes.printOrGraphic = pattern?.label ?? null;
    attributes.material = material?.label ?? null;
    attributes.confidence = { productType: type?.confidence, printOrGraphic: pattern?.confidence, material: material?.confidence };
  } else {
    notes.push('Product type, print and material need CLIP or a vision-language model; only colours were measured.');
  }
  if (!attributes.productType && title) notes.push('Product type was not confidently detected; queries rely on the title.');
  return { attributes, suggestions: {}, notes };
}

export function createProductAnalyzer({ embedder, repo, config, logger }) {
  const vlm = createVlm({ config, logger });
  const providerKey = [config.vision.geminiKey ? config.vision.geminiModel : null, config.vision.fallbackVlm?.model || null, config.vision.anthropicKey ? config.vision.anthropicModel : null].filter(Boolean).join('+');

  return async function analyzeProduct({ title, description, imageBuffer, imageHash, brand, category }) {
    const embedMethod = await embedder.method();
    const cacheKey = sha256(Buffer.from(`v7|${imageHash || 'no-image'}|${title || ''}|${brand || ''}|${category || ''}|${providerKey || embedMethod}|${config.matchScope || 'auto'}`));
    const cached = repo.getCachedAnalysis(cacheKey, config.analysisFailureCacheMs ?? 300_000);
    if (cached) return { ...cached, cached: true };

    let result;
    const warnings = [];
    let providerFailure = null;
    if (vlm.configured) {
      try {
        const analyzed = await analyzeWithVlm({ vlm, title, description, brand, category, imageBuffer });
        const id = /gemini/i.test(analyzed.provider) ? 'gemini' : /claude/i.test(analyzed.provider) ? 'claude' : 'vlm';
        result = { ...analyzed, fromVlm: true, method: imageBuffer ? `${id}-vision` : `${id}-text` };
      } catch (error) {
        const provider = vlm.names[0]?.toLowerCase() || 'vlm';
        logger.warn({ provider, code: error.code || 'ERROR', status: error.status, retryable: Boolean(error.retryable) }, 'VLM analysis failed, using local analysis');
        providerFailure = { provider, code: error.code || 'ERROR', retryable: Boolean(error.retryable), message: error.message };
        const recovery = error.code === 'GEMINI_QUOTA_EXHAUSTED'
          ? 'Check Gemini project quota and billing; fallback attributes are being used.'
          : error.code === 'GEMINI_BILLING_REQUIRED'
            ? 'Enable billing for the Gemini project; fallback attributes are being used.'
            : error.code === 'GEMINI_AUTH'
              ? 'Fix GEMINI_API_KEY (see message); fallback attributes are being used.'
              : error.code === 'GEMINI_TIMEOUT'
                ? 'Gemini did not answer before its configured deadline; check network latency and provider status. Fallback attributes are being used.'
                : error.retryable
                  ? 'The provider may recover; fallback attributes are being used for this search.'
                  : 'Check provider credentials, permissions, model configuration, or quota; fallback attributes are being used.';
        warnings.push(`${provider} vision-language analysis failed (${error.message}). ${recovery} The search plan is built from the product name you typed.`);
      }
    }
    if (!result) {
      const local = await analyzeLocally({ title, imageBuffer, embedder });
      result = { ...local, fromVlm: false, method: imageBuffer ? (embedMethod === 'clip' ? 'clip-zero-shot' : 'pixel-colours') : 'title-only' };
      warnings.push(...(local.notes || []));
    }
    if (embedder.fallbackReason && config.vision.backend === 'clip') warnings.push(`${embedder.fallbackReason}. Scores use basic colour/structure similarity.`);

    const searchPlan = buildPlan({ title, attributes: result.attributes, suggestions: result.suggestions, page: { brand, category }, scope: config.matchScope, fromVlm: result.fromVlm });
    // The plan's product type comes from the typed name; show that rather than a low-confidence CLIP guess.
    const attributes = { ...result.attributes, productType: searchPlan.productType || result.attributes.productType };
    if (!result.fromVlm && result.attributes.productType && result.attributes.productType !== searchPlan.productType) {
      attributes.localGuess = result.attributes.productType;
    }
    const analysis = { attributes, searchPlan, method: result.method, warnings, status: providerFailure || warnings.length ? 'partial' : 'complete', providerFailure };
    repo.cacheAnalysis(cacheKey, analysis);
    return { ...analysis, cached: false };
  };
}
