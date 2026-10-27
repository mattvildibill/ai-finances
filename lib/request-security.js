import { AppError } from './store.js';

/** Bound bytes while reading, including requests without a Content-Length header. */
export async function readJSONBody(request) {
  const limit = 70000;
  if (Number(request.headers.get('content-length')) > limit) {
    if (request.body) void request.body.cancel().catch(() => {});
    throw new AppError('Request too large.', 413);
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          void reader.cancel().catch(() => {});
          throw new AppError('Request too large.', 413);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try { return JSON.parse(text); }
  catch { throw new AppError('Invalid JSON.'); }
}

/** Cookie-authenticated browser callers and OAuth clients share these write checks. */
export function validateWriteRequest(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new AppError('Cross-origin writes are forbidden.', 403);
  }
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new AppError('JSON content type required.', 415);
  }
}
