import { getPromptLocale, tFor } from '../i18n/index.js';

/** Tool descriptions and the hints tools return are read by the model, so they follow the prompt language. */
export function toolText() {
  return tFor(getPromptLocale()).tools;
}
