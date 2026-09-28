import { openDatabase, setDb } from '../server/db/db';
import { invalidateProducts, listProducts, seedCatalogue } from '../server/domain/products';
import { clearSettingsCache } from '../server/services/settings';
import { createUser } from '../server/domain/users';
import { buildApp } from '../server/app';
import type { Actor } from '../server/services/audit';
import type { Role } from '../shared/permissions';
import { TEST_CATALOGUE } from './fixtures/test-catalogue';

/** Fresh in-memory database with the generic test dictionary (or Terram's real one). */
export function freshDb(catalogue: 'test' | 'terram' = 'test') {
  const db = openDatabase(':memory:');
  setDb(db);
  invalidateProducts();
  clearSettingsCache();
  seedCatalogue(catalogue === 'test' ? TEST_CATALOGUE : undefined);
  return db;
}

export const STAFF: Actor = { userId: null, kind: 'user', name: 'Test staff' };

export function productId(slug: string): string {
  const p = listProducts().find((x) => x.slug === slug);
  if (!p) throw new Error(`no product ${slug}`);
  return p.id;
}

/** HTTP client against the real Hono app, with a cookie jar per user. */
export class Client {
  cookie = '';
  constructor(public app = buildApp()) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-terram': '1', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(path: string) {
    return this.req('GET', path);
  }
  post(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.req('POST', path, body ?? {}, headers);
  }
  patch(path: string, body?: unknown) {
    return this.req('PATCH', path, body ?? {});
  }
}

export async function signedIn(role: Role, app = buildApp()) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@terram.test`;
  createUser({ name: `${role} user`, email, role, password: 'password123' }, { userId: null, kind: 'system' });
  const c = new Client(app);
  const r = await c.post('/api/auth/login', { email, password: 'password123' });
  if (r.status !== 200) throw new Error('login failed');
  return c;
}
