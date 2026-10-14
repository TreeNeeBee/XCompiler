import { z } from 'zod';

export const RuleIdentityStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'Expected a non-empty string',
});

// Check author input before Zod's URL parser strips surrounding whitespace.
export const RuleEmbeddingBaseUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && value === value.trim() && !url.username && !url.password
      && !value.includes('?') && !value.includes('#');
  } catch {
    return false;
  }
}, { message: 'Expected an HTTP(S) base URL without credentials, query or fragment' }).pipe(z.string().url());
