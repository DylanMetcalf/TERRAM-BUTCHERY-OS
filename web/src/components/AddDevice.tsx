import QRCode from 'qrcode';
import { Apple, Copy, Laptop, Monitor, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, Segmented, useToast } from './ui';

type Kind = 'iphone' | 'mac' | 'windows' | 'android';

function detect(): Kind {
  const u = navigator.userAgent;
  if (/iPhone|iPad/.test(u)) return 'iphone';
  if (/Android/.test(u)) return 'android';
  if (/Windows/.test(u)) return 'windows';
  return 'mac';
}

const STEPS: Record<Kind, { title: string; steps: string[]; note?: string }> = {
  iphone: {
    title: 'iPhone or iPad',
    steps: [
      'Point the iPhone camera at the QR code (or open the link below in Safari).',
      'Tap the Share button (the square with an arrow) at the bottom of Safari.',
      'Scroll down and tap “Add to Home Screen”, then “Add”.',
      'Open Terram from the new icon, type the family code and tap your name.',
    ],
    note: 'Use Safari for this step — other browsers on iPhone can’t add to the Home Screen.',
  },
  mac: {
    title: 'Mac',
    steps: [
      'Open the link in Safari or Google Chrome.',
      'Safari: File menu → “Add to Dock”.  Chrome: the install icon at the right of the address bar → “Install”.',
      'Open Terram from the Dock or Launchpad, type the family code and pick your name.',
    ],
  },
  windows: {
    title: 'Windows',
    steps: [
      'Open the link in Microsoft Edge or Google Chrome.',
      'Edge: “…” menu → Apps → “Install this site as an app”.  Chrome: install icon in the address bar → “Install”.',
      'Tick “Pin to taskbar” / “Create desktop shortcut” so it’s one click away.',
      'Open Terram, type the family code and pick your name.',
    ],
  },
  android: {
    title: 'Android',
    steps: ['Scan the QR code or open the link in Chrome.', 'Tap “Install app” (or ⋮ menu → “Add to Home screen”).', 'Open Terram, type the family code and pick your name.'],
  },
};

/** Everything needed to put Terram on another phone, tablet or computer. */
export function AddDevice() {
  const toast = useToast();
  // Straight to sign-in (the main address shows the public home page when signed out)
  const url = `${window.location.origin}/login`;
  const [kind, setKind] = useState<Kind>(detect);
  const [qr, setQr] = useState('');
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, width: 220, color: { dark: '#1d1b18', light: '#ffffff' } }).then(setQr).catch(() => setQr(''));
  }, [url]);
  const s = STEPS[kind];
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="flex flex-col items-center p-5 text-center">
        <div className="size-[220px] overflow-hidden rounded-xl bg-white p-1" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: qr }} />
        <p className="mt-3 text-[13px] text-ink-3">Scan with a phone camera</p>
        <p className="mt-2 break-all text-[14px] font-semibold">{url}</p>
        <Button
          size="sm"
          className="mt-3"
          icon={<Copy className="size-3.5" />}
          onClick={() => {
            navigator.clipboard?.writeText(url).then(() => toast({ tone: 'success', title: 'Link copied' })).catch(() => undefined);
          }}
        >
          Copy link
        </Button>
      </Card>
      <Card className="p-5">
        <h2 className="font-display text-xl font-semibold">Put Terram on another device</h2>
        <p className="mt-1 text-[14.5px] text-ink-2">Every device shows the same orders, live. Nothing to download from an app store.</p>
        <div className="-mx-1 mt-4 overflow-x-auto px-1 scrollbar-none">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'iphone', label: <><Smartphone className="size-4" />iPhone</> },
              { value: 'mac', label: <><Apple className="size-4" />Mac</> },
              { value: 'windows', label: <><Monitor className="size-4" />Windows</> },
              { value: 'android', label: <><Laptop className="size-4" />Android</> },
            ]}
          />
        </div>
        <ol className="mt-5 space-y-3">
          {s.steps.map((t, i) => (
            <li key={i} className="flex gap-3 text-[15px]">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-[13px] font-semibold text-brand-ink">{i + 1}</span>
              <span className="pt-0.5">{t}</span>
            </li>
          ))}
        </ol>
        {s.note && <p className="mt-4 rounded-xl bg-ochre-soft px-3.5 py-2.5 text-[13.5px] text-ochre-soft-ink">{s.note}</p>}
        <p className="mt-5 text-[13px] text-ink-3">Don’t know the family code? Ask whoever manages Settings → Team.</p>
      </Card>
    </div>
  );
}
