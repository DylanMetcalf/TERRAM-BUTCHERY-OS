import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Logo } from '../components/order-bits';
import { Avatar, Button, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useBrand } from '../lib/brand';

export function LoginPage({ setup, family }: { setup: boolean; family: boolean }) {
  const { data: brand } = useBrand();
  const parts = (brand?.tagline || 'Grown with Purpose. Shared with Passion.').split(/(?<=\.)\s+/);
  const tagline = { first: parts[0], second: parts.slice(1).join(' ') };
  const [mode, setMode] = useState<'family' | 'email'>(family && !setup ? 'family' : 'email');
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-[#1f1a17] lg:block">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 80% at 20% 10%, var(--brand) 0%, color-mix(in srgb, var(--brand) 45%, #262626) 55%, color-mix(in srgb, var(--brand) 18%, #262626) 100%)' }} />
        <svg className="absolute inset-x-0 bottom-0 w-full opacity-[0.16]" viewBox="0 0 800 400" preserveAspectRatio="none" aria-hidden>
          {Array.from({ length: 14 }).map((_, i) => (
            <path key={i} d={`M-20 ${150 + i * 20} C 200 ${110 + i * 22}, 600 ${110 + i * 22}, 820 ${150 + i * 20}`} stroke="#f6e7d8" strokeWidth="1.4" fill="none" />
          ))}
        </svg>
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Logo tone="light" />
          <div>
            <p className="font-display text-5xl font-medium leading-[1.05] tracking-tight">
              {tagline.first}
              {tagline.second && (
                <>
                  <br />
                  <span className="text-white/75">{tagline.second}</span>
                </>
              )}
            </p>
            <p className="mt-5 max-w-md text-[16px] leading-relaxed text-white/70">Every order enters once, is understood correctly, gets cut, packed and handed over — in one calm place.</p>
          </div>
          <p className="text-[13px] text-white/50">{brand?.name ?? 'Terram Farm'} · Butchery OS</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Logo />
          </div>
          {mode === 'family' ? <FamilySignIn onEmail={() => setMode('email')} /> : <EmailSignIn setup={setup} onFamily={family ? () => setMode('family') : undefined} />}
        </div>
      </div>
    </div>
  );
}

function FamilySignIn({ onEmail }: { onEmail: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('code');
    setError(null);
    try {
      const r = await api.post<{ people: { id: string; name: string }[] }>('/api/auth/family/people', { code });
      setPeople(r.people);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the code.');
    } finally {
      setBusy(null);
    }
  };
  const pick = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.post('/api/auth/family/login', { code, user_id: id });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
      setBusy(null);
    }
  };
  if (people)
    return (
      <div className="animate-rise">
        <button onClick={() => setPeople(null)} className="mb-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-2 hover:text-ink"><ArrowLeft className="size-4" /> Back</button>
        <h1 className="font-display text-3xl font-semibold">Who’s using this device?</h1>
        <p className="mt-2 text-[15px] text-ink-2">It will stay signed in, so you only do this once.</p>
        <div className="mt-8 space-y-2.5">
          {people.map((p) => (
            <button key={p.id} disabled={!!busy} onClick={() => pick(p.id)} className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface px-4 py-3.5 text-left shadow-card transition hover:border-brand active:scale-[0.99] disabled:opacity-60">
              <Avatar name={p.name} size="lg" />
              <span className="flex-1 text-[17px] font-semibold">{p.name}</span>
              {busy === p.id && <span className="text-[13px] text-ink-3">Signing in…</span>}
            </button>
          ))}
          {!people.length && <p className="text-ink-2">Nobody is set up to use the family code yet. An admin can allow it in Settings → Team.</p>}
        </div>
        {error && <p className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">{error}</p>}
      </div>
    );
  return (
    <form onSubmit={unlock} className="animate-rise">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand"><KeyRound className="size-6" /></span>
      <h1 className="mt-5 font-display text-3xl font-semibold">Enter the family code</h1>
      <p className="mt-2 text-[15px] text-ink-2">The same code for everyone at Terram. Then tap your name.</p>
      <div className="mt-8 space-y-4">
        <Field label="Family code" htmlFor="code">
          <Input id="code" big value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required />
        </Field>
        {error && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" full loading={busy === 'code'} disabled={!code.trim()}>Continue</Button>
      </div>
      <button type="button" onClick={onEmail} className="mt-8 block w-full text-center text-[14px] font-medium text-ink-2 hover:text-ink">Sign in with email instead</button>
    </form>
  );
}

function EmailSignIn({ setup, onFamily }: { setup: boolean; onFamily?: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(setup ? '/api/auth/setup' : '/api/auth/login', setup ? { name, email, password } : { email, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="animate-rise">
      <h1 className="font-display text-3xl font-semibold">{setup ? 'Welcome to Terram' : 'Sign in'}</h1>
      <p className="mt-2 text-[15px] text-ink-2">{setup ? 'Create the first admin account to get started.' : 'Use your Terram account.'}</p>
      <div className="mt-8 space-y-4">
        {setup && (
          <Field label="Your name" htmlFor="name">
            <Input id="name" big value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </Field>
        )}
        <Field label="Email" htmlFor="email">
          <Input id="email" big type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus={!setup} />
        </Field>
        <Field label="Password" htmlFor="password" hint={setup ? 'At least 8 characters.' : undefined}>
          <Input id="password" big type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} required minLength={setup ? 8 : undefined} />
        </Field>
        {error && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" full loading={busy}>{setup ? 'Create account' : 'Sign in'}</Button>
      </div>
      {onFamily ? (
        <button type="button" onClick={onFamily} className="mt-8 block w-full text-center text-[14px] font-medium text-ink-2 hover:text-ink">Use the family code instead</button>
      ) : (
        !setup && <p className="mt-8 text-center text-[13px] text-ink-3">Forgot your password? Ask an admin to reset it in Settings → Team.</p>
      )}
    </form>
  );
}
