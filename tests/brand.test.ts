import { beforeEach, describe, expect, it } from 'vitest';
import { Client, freshDb, signedIn } from './helpers';
import { buildApp } from '../server/app';

beforeEach(() => freshDb());

const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10" fill="#2f5d3a"/></svg>').toString('base64');

describe('brand kit', () => {
  it('saves the logo and colour, serves them safely, and can remove the logo again', async () => {
    const app = buildApp();
    const admin = await signedIn('admin', app);
    const staff = await signedIn('staff', app);
    expect((await staff.req('PUT', '/api/admin/settings/brand', { primary: '#2f5d3a' })).status).toBe(403);
    expect((await admin.req('PUT', '/api/admin/settings/brand', { primary: 'green' })).status).toBe(400);
    expect((await admin.req('PUT', '/api/admin/settings/brand', { logo: 'data:text/html;base64,PGgxPg==' })).status).toBe(400);
    expect((await admin.req('PUT', '/api/admin/settings/brand', { logo: svg, primary: '#2f5d3a', showName: false })).status).toBe(200);

    const pub = new Client(app);
    const brand = (await pub.get('/api/public/brand')).body;
    expect(brand).toMatchObject({ primary: '#2f5d3a', hasLogo: true, showName: false });
    const logo = await app.request('/brand/logo');
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(logo.headers.get('content-security-policy')).toContain("default-src 'none'");
    const manifest = await (await app.request('/manifest.webmanifest')).json();
    expect(manifest.theme_color).toBe('#2f5d3a');

    expect((await admin.req('PUT', '/api/admin/settings/brand', { logo: null })).status).toBe(200);
    expect((await pub.get('/api/public/brand')).body.hasLogo).toBe(false);
    expect((await app.request('/brand/logo')).status).toBe(404);
  });
});
