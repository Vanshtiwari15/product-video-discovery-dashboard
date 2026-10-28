import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  // node --test sets NODE_TEST_CONTEXT in test processes; works the same on Windows and Unix.
  level: process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' ? 'silent' : config.logLevel,
  redact: ['token', 'apiKey', 'headers.authorization', 'headers["x-api-key"]'],
});
