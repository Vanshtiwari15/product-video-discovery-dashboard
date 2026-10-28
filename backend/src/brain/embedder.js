import path from 'node:path';
import sharp from 'sharp';
import { l2normalize, structureVector } from './imageUtils.js';

// CLIP ViT-B/32 run locally through transformers.js (ONNX). Weights are downloaded once into DATA_DIR/models.
async function loadClip({ modelId, cacheDir, logger }) {
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = cacheDir;
  const started = Date.now();
  const [processor, visionModel, tokenizer, textModel] = await Promise.all([
    tf.AutoProcessor.from_pretrained(modelId),
    tf.CLIPVisionModelWithProjection.from_pretrained(modelId, { dtype: 'q8' }),
    tf.AutoTokenizer.from_pretrained(modelId),
    tf.CLIPTextModelWithProjection.from_pretrained(modelId, { dtype: 'q8' }),
  ]);
  logger.info({ modelId, ms: Date.now() - started }, 'CLIP model loaded');

  return {
    async embedImage(buffer) {
      const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const image = new tf.RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
      const inputs = await processor(image);
      const { image_embeds: embeds } = await visionModel(inputs);
      return l2normalize(embeds.data);
    },
    // One forward pass for several images (used for the crops of one thumbnail).
    async embedImages(buffers) {
      const images = await Promise.all(buffers.map(async (buffer) => {
        const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        return new tf.RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
      }));
      const inputs = await processor(images);
      const { image_embeds: embeds } = await visionModel(inputs);
      const size = embeds.dims[1];
      return buffers.map((_, i) => l2normalize(embeds.data.slice(i * size, (i + 1) * size)));
    },
    async embedTexts(texts) {
      const inputs = tokenizer(texts, { padding: true, truncation: true });
      const { text_embeds: embeds } = await textModel(inputs);
      const size = embeds.dims[1];
      return texts.map((_, i) => l2normalize(embeds.data.slice(i * size, (i + 1) * size)));
    },
  };
}

// Returns an embedder that prefers CLIP and falls back to the basic colour/structure backend,
// recording why, so scores are never silently produced by the weaker method.
export function createEmbedder({ config, logger }) {
  const wantClip = config.vision.backend === 'clip';
  let clipPromise = null;
  let fallbackReason = wantClip ? null : 'VISION_BACKEND=basic';

  async function clip() {
    if (!wantClip || fallbackReason) return null;
    clipPromise ??= loadClip({ modelId: config.vision.clipModel, cacheDir: path.join(config.dataDir, 'models'), logger });
    try {
      return await clipPromise;
    } catch (error) {
      fallbackReason = `CLIP unavailable (${error.cause?.code || error.message}; model download from huggingface.co may be blocked)`;
      logger.error({ err: error.message }, 'CLIP failed to load, using basic visual similarity');
      return null;
    }
  }

  return {
    async method() {
      return (await clip()) ? 'clip' : 'basic';
    },
    get fallbackReason() {
      return fallbackReason;
    },
    async embedImage(buffer) {
      const model = await clip();
      return model ? { kind: 'clip', vector: await model.embedImage(buffer) } : { kind: 'basic', vector: await structureVector(buffer) };
    },
    async embedImages(buffers) {
      const model = await clip();
      if (model) return { kind: 'clip', vectors: await model.embedImages(buffers) };
      return { kind: 'basic', vectors: await Promise.all(buffers.map((buffer) => structureVector(buffer))) };
    },
    async embedTexts(texts) {
      const model = await clip();
      return model ? model.embedTexts(texts) : null;
    },
  };
}
