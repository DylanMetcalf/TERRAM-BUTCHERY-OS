/** Errors with a message that is safe and useful to show to staff. */
export class AppError extends Error {
  constructor(
    public status: number,
    public userMessage: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(userMessage);
  }
}

export const notFound = (what = 'That item') => new AppError(404, `${what} could not be found.`, 'not_found');
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, msg, 'forbidden');
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'bad_request', details);
export const conflict = (msg: string, details?: unknown) => new AppError(409, msg, 'conflict', details);
