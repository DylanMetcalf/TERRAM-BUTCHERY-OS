// Builds the default app icons from Terram's logo (white logo on brand charcoal).
// Run after changing web/public/brand/terram-logo-white.png: node scripts/make-icons.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const logo = `data:image/png;base64,${fs.readFileSync('web/public/brand/terram-logo-white.png').toString('base64')}`;
const CHARCOAL = '#303030';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(async () => chromium.launch());
// [size, logo scale, file, rounded corners]
for (const [size, scale, name, round] of [
  [192, 0.84, 'icon-192.png', false],
  [512, 0.84, 'icon-512.png', false],
  [512, 0.62, 'icon-maskable-512.png', false],
  [180, 0.84, 'apple-touch-icon.png', false],
  [64, 0.96, 'favicon.png', true],
]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;background:${CHARCOAL};border-radius:${round ? size * 0.22 : 0}px;display:grid;place-items:center"><img src="${logo}" style="width:${Math.round(size * scale)}px;height:${Math.round(size * scale)}px"></div></body></html>`);
  await p.waitForLoadState('networkidle');
  await p.screenshot({ path: `web/public/${name}`, omitBackground: true });
}
await b.close();
