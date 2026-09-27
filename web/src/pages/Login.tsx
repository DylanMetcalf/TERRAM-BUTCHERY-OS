import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Logo } from '../components/order-bits';
import { Button, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';

export function LoginPage({ setup }: { setup: boolean }) {
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
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-[#2a1411] lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_20%_10%,#7b2d26_0%,#3a1814_55%,#1f0f0c_100%)]" />
        <svg className="absolute inset-x-0 bottom-0 w-full opacity-[0.16]" viewBox="0 0 800 400" preserveAspectRatio="none" aria-hidden>
          {Array.from({ length: 14 }).map((_, i) => (
            <path key={i} d={`M-20 ${150 + i * 20} C 200 ${110 + i * 22}, 600 ${110 + i * 22}, 820 ${150 + i * 20}`} stroke="#f6e7d8" strokeWidth="1.4" fill="none" />
          ))}
        </svg>
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Logo tone="light" />
          <div>
            <p className="font-display text-5xl font-medium leading-[1.05] tracking-tight">
              Grown with Purpose.
              <br />
              <span className="text-[#f0c9b8]">Shared with Passion.</span>
            </p>
            <p className="mt-5 max-w-md text-[16px] leading-relaxed text-white/70">Every order enters once, is understood correctly, gets cut, packed and handed over — in one calm place.</p>
          </div>
          <p className="text-[13px] text-white/50">Terram Farm · Butchery OS</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-12">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Logo />
          </div>
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
            {error && (
              <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" full loading={busy}>
              {setup ? 'Create account' : 'Sign in'}
            </Button>
          </div>
          {!setup && <p className="mt-8 text-center text-[13px] text-ink-3">Forgot your password? Ask an admin to reset it in Settings → Team.</p>}
        </form>
      </div>
    </div>
  );
}
