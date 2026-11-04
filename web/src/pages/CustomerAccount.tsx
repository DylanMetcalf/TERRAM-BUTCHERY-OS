import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DeviceOrders } from '../components/Social';
import { PublicShell } from '../components/PublicShell';
import { Button, Card, Field, Input, Spinner, Switch } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, formatMoney } from '../lib/format';
import { validMobile } from '../../../shared/text';

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
            <p className="break-all text-[14px] text-ink-3">Signed in as {data.email} · only your own orders are shown</p>
          </div>
          <Button variant="ghost" icon={<LogOut className="size-4" />} loading={logout.isPending} onClick={() => logout.mutate()}>Sign out</Button>
        </div>
        {!data.orders.length ? (
          <Card className="p-6 text-center text-ink-2">No orders yet for these details. <Link to="/order" className="font-semibold text-brand underline">Place an order</Link></Card>
        ) : (
          <Card className="divide-y divide-line">
            {data.orders.map((o: any) => {
              const total = o.money.finalized_cents ?? o.money.final_cents ?? o.money.confirmed_cents ?? o.money.estimated_cents;
              const exact = o.money.finalized_cents != null || o.money.final_cents != null || o.money.estimate_is_exact;
              return (
                <Link key={o.id} to={o.link} className="flex items-start gap-3 px-4 py-3.5 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-semibold">#{o.order_number} · {o.status_label}</span>
                      {total != null && <span className="font-semibold tabular">{exact ? '' : '≈ '}{formatMoney(total, 'ZAR')}</span>}
                    </div>
                    <div className="text-[13px] text-ink-3">{dateTime(o.created_at)}</div>
                    {o.items?.length > 0 && <div className="mt-1 text-[13.5px] text-ink-2">{o.items.slice(0, 4).map((i: any) => `${i.qty_label} ${i.name}`).join(', ')}{o.items.length > 4 ? ` and ${o.items.length - 4} more` : ''}</div>}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-ink-3">
                      {o.payment_label && <span>Payment: {o.payment_label}</span>}
                      {o.fulfilment_type !== 'collection' && o.delivery_fee_cents != null && o.delivery_fee_cents > 0 && <span>Delivery {formatMoney(o.delivery_fee_cents, 'ZAR')}</span>}
                      {o.money.balance_cents > 0 && <span className="font-medium text-ink-2">Outstanding {formatMoney(o.money.balance_cents, 'ZAR')}</span>}
                      {o.invoice_available && <span className="font-medium text-brand">Invoice available</span>}
                    </div>
                  </div>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-ink-3" />
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

/**
 * "View my orders": the customer's mobile number (or email) and a one-time code — no password.
 * There is no SMS service connected, so the code is emailed to the address on that number's orders.
 */
export function SignIn({ onDone, initialEmail = '', compact }: { onDone: () => void; initialEmail?: string; compact?: boolean }) {
  const [by, setBy] = useState<'phone' | 'email'>(initialEmail ? 'email' : 'phone');
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const who = by === 'phone' ? { phone } : { email };
  const ask = useMutation({ mutationFn: () => api.post<{ message: string }>('/api/public/account/code', who), onSuccess: (r) => setSent(r.message) });
  const verify = useMutation({ mutationFn: () => api.post('/api/public/account/verify', { ...who, code }), onSuccess: onDone });
  const ok = by === 'phone' ? !!validMobile(phone) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const Heading = compact ? 'h2' : 'h1';
  return (
    <Card className={compact ? 'p-5 sm:p-6' : 'mx-auto max-w-md animate-rise p-6'}>
      <Heading className="font-display text-[24px] font-semibold sm:text-[26px]">View my orders</Heading>
      <p className="mt-1 text-[14.5px] text-ink-2">No password needed. Enter the {by === 'phone' ? 'mobile number' : 'email address'} you used when ordering and we’ll send you a 6-digit code{by === 'phone' ? ' by email, to the address on your orders' : ''}.</p>
      {!sent ? (
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) ask.mutate(); }}>
          {by === 'phone' ? (
            <Field label="Mobile number" error={phone.replace(/\D/g, '').length >= 9 && !ok ? 'Please enter a valid mobile number, e.g. 071 234 5678.' : undefined}>
              <Input big type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 071 234 5678" />
            </Field>
          ) : (
            <Field label="Email"><Input big type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          )}
          <Button type="submit" full size="lg" variant="primary" disabled={!ok} loading={ask.isPending}>Send me a code</Button>
          {ask.error && <p className="text-[14px] text-danger" role="alert">{(ask.error as Error).message}</p>}
          <button type="button" className="text-[14px] font-medium text-brand underline" onClick={() => setBy(by === 'phone' ? 'email' : 'phone')}>{by === 'phone' ? 'Use my email address instead' : 'Use my mobile number instead'}</button>
        </form>
      ) : (
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2" role="status">{sent}</p>
          <Field label="6-digit code"><Input big inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className="w-44 tracking-[0.3em]" /></Field>
          <Button type="submit" full size="lg" variant="primary" disabled={code.length !== 6} loading={verify.isPending}>Show my orders</Button>
          {verify.error && <p className="text-[14px] text-danger" role="alert">{(verify.error as Error).message}</p>}
          <button type="button" className="text-[14px] font-medium text-brand underline" onClick={() => { setSent(null); setCode(''); }}>Send a new code, or use different details</button>
        </form>
      )}
    </Card>
  );
}
