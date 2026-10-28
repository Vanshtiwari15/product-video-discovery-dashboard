import { z } from 'zod';
import { badRequest } from '../errors.js';
import { validatePublicUrl } from './urlSafety.js';

const searchSchema = z.object({
  query: z
    .string({ required_error: 'query is required' })
    .trim()
    .min(2, 'Enter at least 2 characters')
    .max(2048, 'Input is too long'),
});

const looksLikeUrl = (text) => /^https?:\/\//i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(text);

// Returns { inputType: 'url' | 'keyword', value } or throws a 400.
export function parseSearchInput(body) {
  const result = searchSchema.safeParse(body ?? {});
  if (!result.success) throw badRequest(result.error.issues[0].message);
  const text = result.data.query;

  if (looksLikeUrl(text)) {
    const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    const url = validatePublicUrl(withScheme);
    return { inputType: 'url', value: url.toString() };
  }
  if (text.length > 200) throw badRequest('Keywords must be 200 characters or fewer');
  return { inputType: 'keyword', value: text.replace(/\s+/g, ' ') };
}

export const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
