import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './lib/errors.js';
import { recordSystemEvent } from './services/health.js';
import { subscribe } from './services/realtime.js';
import { loadUser, requireAuth, type Env } from './http/context.js';
import { csrfGuard, idempotency, securityHeaders } from './http/security.js';
import auth from './routes/auth.js';
import orders, { items } from './routes/orders.js';
import production from './routes/production.js';
import { customers, products } from './routes/catalog.js';
import { exceptions, imports, intelligence, misc } from './routes/intelligence.js';
import admin from './routes/admin.js';
import publicRoutes from './routes/public.js';
import integrations from './routes/integrations.js';

export function buildApp(opts: { staticDir?: string | null } = {}) {
  const app = new Hono<Env>();

  app.use('*', securityHeaders);
  app.use('*', async (c, next) => {
    c.set('requestId', Math.random().toString(36).slice(2, 10));
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.status === 401 && err.code === 'unauthenticated') return c.json({ error: err.userMessage, code: err.code }, 401);
      return c.json({ error: err.userMessage, code: err.code, details: err.status === 400 ? err.details : undefined }, err.status as any);
    }
    if (err?.name === 'ZodError') return c.json({ error: 'Please check the details and try again.', code: 'bad_request' }, 400);
    const ref = c.get('requestId') ?? '';
    recordSystemEvent('error', 'server', `Unexpected error on ${c.req.method} ${c.req.path}`, { ref, error: err?.stack ?? String(err) });
    return c.json({ error: `Something went wrong on our side. Please try again. (ref ${ref})`, code: 'server_error' }, 500);
  });

  const api = new Hono<Env>();
  api.use('*', loadUser);
  api.use('*', csrfGuard);
  api.use('*', idempotency);
  api.route('/auth', auth);
  api.route('/public', publicRoutes);
  api.route('/integrations', integrations);
  api.route('/orders', orders);
  api.route('/items', items);
  api.route('/production', production);
  api.route('/customers', customers);
  api.route('/products', products);
  api.route('/imports', imports);
  api.route('/exceptions', exceptions);
  api.route('/intelligence', intelligence);
  api.route('/admin', admin);
  api.route('/', misc);

  api.get('/health', (c) => c.json({ ok: true }));

  // Live updates to every signed-in device
  api.get('/events', requireAuth(), (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const unsub = subscribe((e) => {
        if (open) stream.writeSSE({ event: 'change', data: JSON.stringify(e) }).catch(() => undefined);
      });
      stream.onAbort(() => {
        open = false;
        unsub();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: new Date().toISOString() }) });
      while (open) {
        await stream.sleep(25_000);
        if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => (open = false));
      }
    }),
  );

  api.all('*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));
  app.route('/api', api);

  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    const rel = path.relative(process.cwd(), staticDir) || '.';
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('*', serveStatic({ root: rel }));
    // Missing hashed assets must 404 (never fall through to index.html) so a client
    // running an older build can detect it and reload.
    app.get('/assets/*', (c) => c.text('Not found', 404));
    const indexPath = path.join(staticDir, 'index.html');
    let cached = { mtime: 0, html: '' };
    app.get('*', (c) => {
      const m = fs.statSync(indexPath).mtimeMs;
      if (m !== cached.mtime) cached = { mtime: m, html: fs.readFileSync(indexPath, 'utf8') };
      c.header('Cache-Control', 'no-cache');
      return c.html(cached.html);
    });
  }
  return app;
}
