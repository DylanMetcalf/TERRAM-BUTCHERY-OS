/** Thin API client: JSON, CSRF header, idempotency keys, friendly errors. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function request<T>(method: string, url: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-terram': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, navigator.onLine ? 'Could not reach the server. Please try again.' : 'You are offline. Your changes have not been sent yet.', 'network');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new CustomEvent('terram:unauthenticated'));
    throw new ApiError(res.status, data?.error ?? `Something went wrong (${res.status}).`, data?.code, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, opts?: { idempotencyKey?: string }) => request<T>('POST', url, body ?? {}, opts),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
