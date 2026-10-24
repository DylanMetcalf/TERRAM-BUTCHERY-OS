import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DeviceOrders } from '../components/Social';
import { PublicShell } from '../components/PublicShell';
import { Button, Card, Field, Input, Spinner, Switch } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, formatMoney } from '../lib/format';

/**
 * Order history without a password: the customer types their email, we send a 6-digit code,
 * and the code opens a session on this device. No account has to be created to order.
 */
export default function CustomerAccount() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const linkToken = params.get('k');
  // "See all your orders" from an email: the link itself proves the address, so sign straight in
  const viaLink = useMutation({
    mutationFn: (token: string) => api.post('/api/public/account/link', { token }),
    onSettled: () => {
      setParams({}, { replace: true });
      qc.invalidateQueries({ queryKey: ['customer-account'] });
    },
  });
  useEffect(() => {
    if (linkToken && !viaLink.isPending) viaLink.mutate(linkToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkToken]);
  const { data, error, isLoading } = useQuery({ queryKey: ['customer-account'], queryFn: () => api.get<any>('/api/public/account'), retry: false, enabled: !linkToken });
  useEffect(() => {
    document.title = 'Your orders';
  }, []);
  const signedOut = error instanceof ApiError && error.status === 401;
  const logout = useMutation({ mutationFn: () => api.post('/api/public/account/logout'), onSuccess: () => qc.removeQueries({ queryKey: ['customer-account'] }) });
  const prefs = useMutation({ mutationFn: (reminders: boolean) => api.post<any>('/api/public/account/preferences', { reminders }), onSuccess: (r) => qc.setQueryData(['customer-account'], r) });

  if (isLoading || linkToken) return <PublicShell subtitle="Your orders"><div className="flex justify-center py-24"><Spinner className="size-6" /></div></PublicShell>;
  if (signedOut || !data)
    return (
      <PublicShell subtitle="Your orders">
        {viaLink.error && <p className="mx-auto mb-4 max-w-md rounded-xl bg-ochre-soft px-4 py-3 text-[14px] text-ochre-soft-ink">{(viaLink.error as Error).message}</p>}
        <SignIn initialEmail={params.get('email') ?? ''} onDone={() => qc.invalidateQueries({ queryKey: ['customer-account'] })} />
        <div className="mx-auto mt-5 max-w-md"><DeviceOrders limit={10} /></div>
      </PublicShell>
    );

  return (
    <PublicShell subtitle="Your orders">
      <div className="animate-rise space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-[28px] font-semibold">Your orders</h1>
            <p className="break-all text-[14px] text-ink-3">Signed in as {data.email}</p>
          </div>
          <Button variant="ghost" icon={<LogOut className="size-4" />} loading={logout.isPending} onClick={() => logout.mutate()}>Sign out</Button>
        </div>
        {!data.orders.length ? (
          <Card className="p-6 text-center text-ink-2">No orders yet for this email address. <Link to="/order" className="font-semibold text-brand underline">Place an order</Link></Card>
        ) : (
          <Card className="divide-y divide-line">
            {data.orders.map((o: any) => {
              const total = o.money.final_cents ?? o.money.confirmed_cents ?? o.money.estimated_cents;
              return (
                <Link key={o.id} to={o.link} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">#{o.order_number} · {o.status_label}</div>
                    <div className="text-[13px] text-ink-3">{dateTime(o.created_at)} · {o.item_count} item{o.item_count === 1 ? '' : 's'}{total != null ? ` · ${o.money.final_cents != null || o.money.estimate_is_exact ? '' : '≈ '}${formatMoney(total, 'ZAR')}` : ''}</div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-ink-3" />
                </Link>
              );
            })}
          </Card>
        )}
        <Card className="p-4">
          <h2 className="font-semibold">Email preferences</h2>
          <div className="mt-3">
            <Switch checked={data.preferences.reminders} onChange={(v) => prefs.mutate(v)} disabled={prefs.isPending} label="Reorder reminders" description="An occasional email when it’s time to stock up again. Order updates are always sent." />
          </div>
        </Card>
      </div>
    </PublicShell>
  );
}

function SignIn({ onDone, initialEmail }: { onDone: () => void; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const ask = useMutation({ mutationFn: () => api.post<{ message: string }>('/api/public/account/code', { email }), onSuccess: (r) => setSent(r.message) });
  const verify = useMutation({ mutationFn: () => api.post('/api/public/account/verify', { email, code }), onSuccess: onDone });
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return (
    <Card className="mx-auto max-w-md animate-rise p-6">
      <h1 className="font-display text-[26px] font-semibold">See your orders</h1>
      <p className="mt-1 text-[14.5px] text-ink-2">No password needed. Enter the email address you used when ordering and we’ll send you a 6-digit code.</p>
      {!sent ? (
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) ask.mutate(); }}>
          <Field label="Email"><Input big type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" full size="lg" variant="primary" disabled={!ok} loading={ask.isPending}>Send me a code</Button>
          {ask.error && <p className="text-[14px] text-danger" role="alert">{(ask.error as Error).message}</p>}
        </form>
      ) : (
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2">{sent}</p>
          <Field label="6-digit code"><Input big inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className="w-44 tracking-[0.3em]" /></Field>
          <Button type="submit" full size="lg" variant="primary" disabled={code.length !== 6} loading={verify.isPending}>Sign in</Button>
          {verify.error && <p className="text-[14px] text-danger" role="alert">{(verify.error as Error).message}</p>}
          <button type="button" className="text-[14px] font-medium text-brand underline" onClick={() => { setSent(null); setCode(''); }}>Use a different email or send a new code</button>
        </form>
      )}
    </Card>
  );
}
