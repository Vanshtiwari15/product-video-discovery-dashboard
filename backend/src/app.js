
import express from 'express';
import multer from 'multer';
import { AppError } from './errors.js';
import { searchRoutes } from './routes/search.routes.js';

export function createApp({ repo, queue, runSearch, progress, config, logger, health }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.endsWith('/events')) return;
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }, 'request');
    });
    next();
  });

  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', config.corsOrigin);
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/media', express.static(config.mediaDir, { fallthrough: false, maxAge: '7d', index: false }));
  app.get('/api/health', (req, res) => res.json({ ok: true, ...health() }));
  app.use('/api', searchRoutes({ repo, queue, runSearch, progress, config }));
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'Image must be 6 MB or smaller' : `Upload error: ${error.message}`;
      return res.status(400).json({ error: { code: 'BAD_UPLOAD', message } });
    }
    if (error.status === 404 && req.path.startsWith('/media')) return res.status(404).end();
    logger.error({ err: error.message, stack: error.stack, path: req.path }, 'unhandled error');
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  });

  return app;
}

