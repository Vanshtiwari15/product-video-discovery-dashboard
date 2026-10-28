import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { badRequest, notFound } from '../errors.js';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, parseSearchInput } from '../validation/input.js';
import { normalizeImage } from '../brain/imageUtils.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

function toVideoDto(row) {
  return {
    key: row.video_key,
    platform: row.platform,
    platformId: row.platform_id,
    url: row.url,
    videoUrl: row.video_url,
    thumbnailUrl: row.thumbnail_file ? `/media/thumbs/${row.thumbnail_file}` : null,
    caption: row.caption,
    author: row.author,
    publishedAt: row.published_at,
    score: row.score,
    matchStatus: row.match_status,
    previouslySeen: Boolean(row.previously_seen),
    explanation: row.score_detail,
    foundBy: row.found_by,
    isDemo: Boolean(row.is_demo),
    extra: row.extra,
  };
}

function toProductDto(product) {
  if (!product) return null;
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    sourceUrl: product.source_url,
    imageUrl: product.image_hash ? `/media/products/${product.image_hash.slice(0, 32)}.jpg` : null,
    remoteImageUrl: product.image_url,
    attributes: product.attributes,
    searchPlan: product.queries,
    analysisMethod: product.analysis_method,
  };
}

const toSearchDto = (row) => ({
  id: row.id,
  inputType: row.input_type,
  input: row.input_text,
  hasUpload: Boolean(row.has_upload),
  status: row.status,
  stage: row.stage,
  error: row.error,
  isDemo: Boolean(row.is_demo),
  summary: row.source_summary,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

export function searchRoutes({ repo, queue, runSearch, progress, config }) {
  const router = express.Router();

  router.post('/search', upload.single('image'), async (req, res, next) => {
    try {
      const input = parseSearchInput(req.body);
      let uploadImage = null;
      if (req.file) {
        if (!ALLOWED_UPLOAD_TYPES.has(req.file.mimetype)) throw badRequest('Image must be JPEG, PNG or WebP');
        await normalizeImage(req.file.buffer).catch(() => {
          throw badRequest('The uploaded file could not be read as an image');
        });
        uploadImage = { buffer: req.file.buffer, mimetype: req.file.mimetype };
      }

      const id = crypto.randomUUID();
      repo.createSearch({ id, inputType: input.inputType, inputText: input.value, hasUpload: Boolean(uploadImage), isDemo: config.demoMode });
      progress.init(id);
      queue.enqueue(`search:${id}`, () => runSearch(id, { ...input, upload: uploadImage }));
      res.status(202).json({ id, status: 'queued', inputType: input.inputType, isDemo: config.demoMode });
    } catch (error) {
      next(error);
    }
  });

  router.get('/search/:id', (req, res, next) => {
    const search = repo.getSearch(req.params.id);
    if (!search) return next(notFound('Search not found'));
    const videos = repo.getSearchVideos(search.id).map(toVideoDto);
    res.json({
      search: toSearchDto(search),
      product: toProductDto(search.product_id ? repo.getProduct(search.product_id) : null),
      progress: progress.snapshot(search.id),
      results: {
        instagram: videos.filter((v) => v.platform === 'instagram'),
        meta: videos.filter((v) => v.platform === 'meta'),
      },
    });
  });

  // Server-sent events: current snapshot first, then every change until the search finishes.
  router.get('/search/:id/events', (req, res, next) => {
    const search = repo.getSearch(req.params.id);
    if (!search) return next(notFound('Search not found'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
    const finished = (status) => ['complete', 'partial', 'failed', 'interrupted'].includes(status);

    const snapshot = progress.snapshot(search.id);
    if (!snapshot || finished(search.status)) {
      send(snapshot ?? { status: search.status, stages: null });
      return res.end();
    }
    send(snapshot);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    const unsubscribe = progress.subscribe(search.id, (state) => {
      send(state);
      if (finished(state.status)) cleanup();
    });
    function cleanup() {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
    req.on('close', cleanup);
  });

  router.get('/history', (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    res.json({
      searches: repo.listSearches(limit).map((row) => ({
        ...toSearchDto(row),
        productTitle: row.product_title,
        productImageUrl: row.product_image_hash ? `/media/products/${row.product_image_hash.slice(0, 32)}.jpg` : null,
        newMatches: row.new_matches,
      })),
    });
  });

  return router;
}
