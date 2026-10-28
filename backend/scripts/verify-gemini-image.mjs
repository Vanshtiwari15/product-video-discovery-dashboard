import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { geminiJson } from '../src/brain/gemini.js';

const imagePath = process.argv[2];
const modelOverride = process.argv[3];
if (!imagePath) {
  console.error('Usage: node scripts/verify-gemini-image.mjs <image-path>');
  process.exit(2);
}
if (!config.vision.geminiKey) {
  console.error('GEMINI_API_KEY is not configured in backend/.env');
  process.exit(2);
}

const absolutePath = path.resolve(imagePath);
const imageBuffer = fs.readFileSync(absolutePath);
const metadata = await sharp(imageBuffer).metadata();
const startedAt = Date.now();
const activeConfig = modelOverride
  ? { ...config, vision: { ...config.vision, geminiModel: modelOverride } }
  : config;

try {
  const result = await geminiJson({
    config: activeConfig,
    logger: { info() {}, warn() {} },
    label: 'gemini-live-image-check',
    prompt: `Inspect this ecommerce product photo. Return ONLY JSON with this shape:
{"product_type":string|null,"colors":string[],"shape":string|null,"logos":string[],"text_on_product":string[],"material":string|null,"confidence_notes":string[]}
Report a logo or printed text only if actually visible and readable. Do not infer either from the product category or brand in the prompt. Use empty arrays or null when uncertain. Keep confidence notes concise.`,
    images: [{ label: 'Product reference image:', buffer: imageBuffer }],
  });
  console.log(JSON.stringify({
    result: 'success',
    model: activeConfig.vision.geminiModel,
    durationMs: Date.now() - startedAt,
    image: { format: metadata.format, width: metadata.width, height: metadata.height, bytes: imageBuffer.length },
    productType: result.product_type ?? null,
    colors: result.colors ?? [],
    shape: result.shape ?? null,
    logos: result.logos ?? [],
    textOnProduct: result.text_on_product ?? [],
    material: result.material ?? null,
    confidenceNotes: result.confidence_notes ?? [],
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    result: 'failed',
    model: activeConfig.vision.geminiModel,
    durationMs: Date.now() - startedAt,
    image: { format: metadata.format, width: metadata.width, height: metadata.height, bytes: imageBuffer.length },
    code: error.code || 'ERROR',
    status: error.status ?? null,
    retryable: Boolean(error.retryable),
    message: error.message,
  }, null, 2));
  process.exitCode = 1;
}