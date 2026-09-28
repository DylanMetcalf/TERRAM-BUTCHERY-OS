import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './lib/errors.js';
import { recordSystemEvent } from './services/health.js';
import { subscribe } from './services/realtime.js';
import { DEFAULT_BRAND_COLOUR, getSettings } from './services/settings.js';
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

  // Brand kit assets (logo, app icons) and a manifest that follows the brand
  const fromDataUrl = (d: string) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(d)!;
    return { type: m[1], body: Buffer.from(m[2], 'base64') };
  };
  const brandAsset = (key: 'logo' | 'icon192' | 'icon512') => (c: any) => {
    const b = getSettings().brand;
    const data = b[key];
    if (!data) return c.notFound();
    const { type, body } = fromDataUrl(data);
    c.header('Content-Type', type);
    c.header('Cache-Control', 'public, max-age=300');
    // An uploaded SVG must never be able to run script on our origin
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(body);
  };
  app.get('/brand/logo', brandAsset('logo'));
  app.get('/brand/icon-192.png', brandAsset('icon192'));
  app.get('/brand/icon-512.png', brandAsset('icon512'));
  app.get('/manifest.webmanifest', (c) => {
    const s = getSettings();
    const custom = !!s.brand.icon512;
    const v = s.brand.version;
    c.header('Cache-Control', 'no-cache');
    return c.json(
      {
        name: `${s.business.name} Butchery`,
        short_name: s.business.name.split(' ')[0] || 'Terram',
        description: 'Orders, cutting, packing and fulfilment.',
        start_url: '/login',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f5f2',
        theme_color: s.brand.primary.toLowerCase() === DEFAULT_BRAND_COLOUR ? '#303030' : s.brand.primary,
        icons: custom
          ? [
              { src: `/brand/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png' },
              { src: `/brand/icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            ]
          : [
              { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
              { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
        shortcuts: [
          { name: 'Paste orders', url: '/import' },
          { name: 'Cutting', url: '/cutting' },
          { name: 'Packing', url: '/packing' },
        ],
      },
      200,
      { 'Content-Type': 'application/manifest+json' },
    );
  });
  // Home-screen icon for iPhones follows the brand too
  app.get('/apple-touch-icon.png', (c) => {
    const b = getSettings().brand;
    if (b.icon192) return brandAsset('icon192')(c);
    return c.redirect('/icon-192.png');
  });

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
