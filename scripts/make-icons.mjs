import { chromium } from 'playwright-core';
import fs from 'node:fs';
const svg = fs.readFileSync('web/public/icon.svg', 'utf8');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(async () => chromium.launch());
for (const [size, pad, name] of [[192, 0, 'icon-192.png'], [512, 0, 'icon-512.png'], [512, 64, 'icon-maskable-512.png']]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  const inner = pad ? svg.replace('rx="9"', 'rx="0"') : svg;
  await p.setContent(`<html><body style="margin:0;background:${pad ? '#7b2d26' : 'transparent'}"><div style="padding:${pad}px;box-sizing:border-box;width:${size}px;height:${size}px">${inner.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await p.screenshot({ path: `web/public/${name}`, omitBackground: !pad });
}
await b.close();
