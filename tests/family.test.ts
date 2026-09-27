import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, freshDb, signedIn } from './helpers';
import { buildApp } from '../server/app';
import { db } from '../server/db/db';
import { listBackups, runBackup } from '../server/services/jobs';

beforeEach(() => freshDb());

describe('family code sign-in', () => {
  it('lets family members sign in with one shared code and stays signed in for months', async () => {
    const app = buildApp();
    const admin = await signedIn('admin', app);
    expect((await admin.req('PUT', '/api/admin/family-code', { code: 'short' })).status).toBe(400);
    expect((await admin.req('PUT', '/api/admin/family-code', { code: 'Red Barn  Mince' })).status).toBe(200);
    const mom = await admin.post('/api/admin/users', { name: 'Mom', role: 'manager', family_login: true });
    expect(mom.status).toBe(200);
    await admin.post('/api/admin/users', { name: 'Seasonal helper', role: 'staff', password: 'password123', email: 'helper@terram.test' });

    const phone = new Client(app);
    expect((await phone.get('/api/auth/me')).body.family_login).toBe(true);
    expect((await phone.post('/api/auth/family/people', { code: 'wrong code' })).status).toBe(401);
    const people = await phone.post('/api/auth/family/people', { code: 'red barn mince' }); // case & spacing forgiven
    expect(people.body.people.map((p: any) => p.name)).toEqual(['Mom']);
    const login = await phone.post('/api/auth/family/login', { code: 'red barn mince', user_id: mom.body.user.id });
    expect(login.status).toBe(200);
    const me = await phone.get('/api/auth/me');
    expect(me.body.user.name).toBe('Mom');
    expect(me.body.user.role).toBe('manager');
    const session = db().prepare("SELECT expires_at FROM sessions WHERE via = 'family'").get() as any;
    expect((Date.parse(session.expires_at) - Date.now()) / 86400_000).toBeGreaterThan(170);
  });

  it('only lists people an admin has allowed, and never with a wrong code', async () => {
    const app = buildApp();
    const admin = await signedIn('admin', app);
    await admin.req('PUT', '/api/admin/family-code', { code: 'terram family 2026' });
    const helper = await admin.post('/api/admin/users', { name: 'Helper', role: 'staff', password: 'password123', email: 'h@terram.test' });
    const c = new Client(app);
    const r = await c.post('/api/auth/family/login', { code: 'terram family 2026', user_id: helper.body.user.id });
    expect(r.status).toBe(403);
  });

  it('rate-limits code guessing', async () => {
    const app = buildApp();
    const admin = await signedIn('admin', app);
    await admin.req('PUT', '/api/admin/family-code', { code: 'terram family 2026' });
    const c = new Client(app);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.req('POST', '/api/auth/family/people', { code: `guess ${i}` }, { 'x-forwarded-for': '10.9.9.9' })).status;
    expect(last).toBe(429);
  });

  it('an admin can sign out every other device', async () => {
    const app = buildApp();
    const admin = await signedIn('admin', app);
    const other = await signedIn('staff', app);
    expect((await other.get('/api/orders')).status).toBe(200);
    await admin.post('/api/admin/sessions/sign-out-others');
    expect((await other.get('/api/orders')).status).toBe(401);
    expect((await admin.get('/api/orders')).status).toBe(200);
  });
});

describe('backups', () => {
  it('writes a restorable copy and keeps a limited number', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terram-bk-'));
    process.env.BACKUP_DIR = dir;
    process.env.BACKUP_KEEP = '2';
    for (let i = 0; i < 3; i++) {
      await runBackup('manual');
      await new Promise((r) => setTimeout(r, 1100));
    }
    const files = listBackups();
    expect(files.length).toBeLessThanOrEqual(2);
    const Database = (await import('better-sqlite3')).default;
    const copy = new Database(path.join(dir, files[0].file), { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) n FROM products').get() as any).n).toBeGreaterThan(20);
    delete process.env.BACKUP_DIR;
    delete process.env.BACKUP_KEEP;
  });
});
