import { AppError } from './store.js';

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
