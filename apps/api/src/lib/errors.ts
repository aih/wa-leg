export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message?: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message?: string, details?: unknown) => new HttpError(409, code, message, details);
export const preconditionFailed = (details?: unknown) => new HttpError(412, 'precondition_failed', 'Version conflict', details);
export const unprocessable = (code: string, message?: string, details?: unknown) => new HttpError(422, code, message, details);
export const unavailable = (code: string, message?: string) => new HttpError(503, code, message);
