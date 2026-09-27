import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Route, Routes, useLocation, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useMe } from '../lib/auth';
import { useBrand } from '../lib/brand';
import { dateTime, friendlyDate, longDate, qtyBeforeName, todayYmd } from '../lib/format';
import { STATUS_LABEL, SOURCE_LABEL } from '../../../shared/workflow';
import type { OrderItem, OrderSummary } from '../lib/types';

/**
 * Dedicated print layouts. Black-and-white friendly, large type for the
 * cutting room, no navigation chrome. Opens the print dialog automatically.
 */
export default function PrintView() {
  return (
    <Routes>
      <Route path="cutting" element={<CuttingPrint />} />
      <Route path="packing" element={<PackingPrint />} />
      <Route path="dockets" element={<DocketsPrint />} />
      <Route path="ready" element={<ReadyPrint />} />
      <Route path="order/:id" element={<OrderPrint />} />
    </Routes>
  );
}

function Page({ title, subtitle, children, ready }: { title: string; subtitle?: string; children: ReactNode; ready: boolean }) {
  const me = useMe();
  const { data: brand } = useBrand();
  useEffect(() => {
    document.title = `${title} — ${me.business.name}`;
    if (ready) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [ready, title, me.business.name]);
  return (
    <div className="min-h-dvh bg-white text-black">
      <style>{`@page { size: A4; margin: 12mm; } @media print { .no-print { display: none !important; } .break { break-after: page; } .avoid { break-inside: avoid; } }`}</style>
      <div className="no-print sticky top-0 flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-6 py-3 text-[14px]">
        <span className="text-neutral-600">Print preview</span>
        <div className="flex gap-2">
          <button onClick={() => window.close()} className="rounded-lg border border-neutral-300 px-3 py-1.5">Close</button>
          <button onClick={() => window.print()} className="rounded-lg bg-black px-4 py-1.5 font-medium text-white">Print</button>
        </div>
      </div>
      <div className="mx-auto max-w-[780px] px-6 py-6 print:max-w-none print:p-0">
        <header className="mb-5 flex items-end justify-between border-b-2 border-black pb-2">
          <div className="flex items-end gap-3">
            {brand?.hasLogo && <img src={`/brand/logo?v=${brand.version}`} alt="" className="h-12 w-auto max-w-[120px] object-contain" />}
            <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em]">{me.business.name} · Butchery</div>
            <h1 className="font-display text-[26px] font-bold leading-tight">{title}</h1>
            {subtitle && <div className="text-[13px]">{subtitle}</div>}
            </div>
          </div>
          <div className="text-right text-[11px]">Printed {dateTime(new Date().toISOString())}<br />by {me.user?.name}</div>
        </header>
        {!ready ? <p>Loading…</p> : children}
      </div>
    </div>
  );
}

function CuttingPrint() {
  const loc = useLocation();
  const range = new URLSearchParams(loc.search).get('range') ?? 'week';
  const { data } = useQuery({ queryKey: ['cutting', range, 'print'], queryFn: () => api.get<any>(`/api/production/cutting${qs({ range })}`) });
  const today = todayYmd();
  const title = range === 'today' ? 'Daily cutting sheet' : range === 'tomorrow' ? 'Cutting sheet — tomorrow' : range === 'all' ? 'Cutting sheet — all open orders' : 'Cutting sheet — next 7 days';
  const cats = data ? [...new Set<string>(data.lines.map((l: any) => l.category))] : [];
  return (
    <Page title={title} subtitle={data?.from ? `${friendlyDate(data.from, today)} – ${friendlyDate(data.to, today)} · ${data.order_count} orders` : data ? `${data.order_count} orders` : ''} ready={!!data}>
      {data && !data.lines.length && <p className="text-[16px]">Nothing to cut.</p>}
      {cats.map((cat) => (
        <section key={cat} className="avoid mb-5">
          <h2 className="mb-1 border-b border-black text-[15px] font-bold uppercase tracking-wide">{cat}</h2>
          <table className="w-full border-collapse text-[14px]">
            <tbody>
              {data.lines.filter((l: any) => l.category === cat).map((l: any) => (
                <tr key={l.key} className="avoid border-b border-neutral-400 align-top">
                  <td className="w-7 py-2 pr-2"><span className="inline-block size-5 border-2 border-black" /></td>
                  <td className="py-2 pr-3">
                    <div className="text-[16px] font-bold">{l.product_name}{l.preparation_label ? <span className="font-bold"> — {l.preparation_label.toUpperCase()}</span> : ''}</div>
                    <div className="mt-0.5 text-[12px] leading-snug">
                      {l.orders.map((o: any) => `${o.customer_name} ${o.qty_label}${o.special_instructions ? ` [${o.special_instructions}]` : ''}`).join(' · ')}
                    </div>
                  </td>
                  <td className="whitespace-nowrap py-2 text-right text-[20px] font-bold">{l.total_label}<div className="text-[11px] font-normal">{l.estimate_label}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </Page>
  );
}

function PackSlip({ o, items, notes }: { o: OrderSummary; items: OrderItem[]; notes?: string | null }) {
  const today = todayYmd();
  return (
    <div className="avoid mb-4 border-2 border-black p-3">
      <div className="flex items-start justify-between border-b border-black pb-1.5">
        <div className="text-[22px] font-bold uppercase leading-tight">{o.customer_name}</div>
        <div className="text-right text-[12px]"><b className="text-[15px]">#{o.order_number}</b><br />{o.fulfilment_type === 'delivery' ? 'DELIVERY' : 'COLLECTION'} · {friendlyDate(o.requested_date, today)}{o.time_window ? ` · ${o.time_window}` : ''}</div>
      </div>
      <table className="mt-1.5 w-full text-[15px]">
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-b border-dotted border-neutral-500 align-top last:border-0">
              <td className="w-7 py-1.5"><span className="inline-block size-5 border-2 border-black" /></td>
              <td className="w-24 py-1.5 font-bold">{qtyBeforeName(i.qty)}</td>
              <td className="py-1.5">
                <b>{i.product_name}</b>{i.preparation_label ? ` — ${i.preparation_label}` : ''}
                {i.special_instructions && <div className="text-[13px] font-bold">⚑ {i.special_instructions}</div>}
              </td>
              <td className="w-20 py-1.5 text-right text-[11px]">____ kg</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(notes || o.delivery_address) && (
        <div className="mt-1.5 border-t border-black pt-1 text-[12.5px]">
          {o.fulfilment_type === 'delivery' && o.delivery_address && <div><b>Address:</b> {o.delivery_address}{o.contact_phone ? ` · ${o.contact_phone}` : ''}</div>}
          {notes && <div><b>Note:</b> {notes}</div>}
        </div>
      )}
      <div className="mt-2 flex justify-between text-[11px]"><span>Packed by: ____________</span><span>Checked: ____</span></div>
    </div>
  );
}

function PackingPrint() {
  const { data } = useQuery({ queryKey: ['packing', 'print'], queryFn: () => api.get<any>('/api/production/packing') });
  return (
    <Page title="Packing slips" subtitle={data ? `${data.ready_to_pack.length} orders ready to pack` : ''} ready={!!data}>
      {data && !data.ready_to_pack.length && <p>Nothing to pack.</p>}
      {data?.ready_to_pack.map((o: any) => <PackSlip key={o.id} o={o} items={o.items} notes={o.notes} />)}
    </Page>
  );
}

function DocketsPrint() {
  const loc = useLocation();
  const date = new URLSearchParams(loc.search).get('date');
  const { data } = useQuery({ queryKey: ['dockets', date], queryFn: () => api.get<any>(`/api/production/dockets${qs({ date })}`) });
  return (
    <Page title="Order dockets" subtitle={data ? `${date ? longDate(date) : 'All open orders'} · ${data.orders.length} orders` : ''} ready={!!data}>
      {data && !data.orders.length && <p>No confirmed orders for this day.</p>}
      <div className="grid grid-cols-2 gap-x-4 print:grid-cols-2">
        {data?.orders.map((o: any) => <PackSlip key={o.id} o={o} items={o.items} notes={o.notes} />)}
      </div>
    </Page>
  );
}

function ReadyPrint() {
  const { data } = useQuery({ queryKey: ['fulfilment', 'print'], queryFn: () => api.get<any>('/api/production/fulfilment') });
  const today = todayYmd();
  const groups = data ? [['Collections', data.ready.filter((o: any) => o.fulfilment_type !== 'delivery')], ['Deliveries', data.ready.filter((o: any) => o.fulfilment_type === 'delivery')]] : [];
  return (
    <Page title="Ready orders" subtitle={data ? longDate(today) : ''} ready={!!data}>
      {groups.map(([label, list]: any) => (
        <section key={label} className="mb-6">
          <h2 className="mb-1 border-b border-black text-[15px] font-bold uppercase">{label} · {list.length}</h2>
          <table className="w-full text-[13.5px]">
            <tbody>
              {list.map((o: any) => (
                <tr key={o.id} className="border-b border-neutral-400 align-top">
                  <td className="w-7 py-2"><span className="inline-block size-5 border-2 border-black" /></td>
                  <td className="w-16 py-2 font-bold">#{o.order_number}</td>
                  <td className="py-2"><b>{o.customer_name}</b> {o.contact_phone ?? o.customer_phone ?? ''}<div className="text-[12px]">{o.items.map((i: any) => `${i.qty_label} ${i.product_name}`).join(', ')}</div>{o.fulfilment_type === 'delivery' && <div className="text-[12px]"><b>{o.delivery_address ?? 'NO ADDRESS'}</b></div>}</td>
                  <td className="w-28 py-2 text-right">{friendlyDate(o.requested_date, today)}<div className="text-[11px]">{o.customer_notified_at ? 'Notified' : 'Not notified'}</div></td>
                </tr>
              ))}
              {!list.length && <tr><td className="py-2">None.</td></tr>}
            </tbody>
          </table>
        </section>
      ))}
    </Page>
  );
}

function OrderPrint() {
  const { id } = useParams();
  const { data } = useQuery({ queryKey: ['order', id, 'print'], queryFn: () => api.get<any>(`/api/orders/${id}`) });
  const o = data?.order as OrderSummary | undefined;
  return (
    <Page title={o ? `Order #${o.order_number}` : 'Order'} subtitle={o ? `${STATUS_LABEL[o.status]} · ${SOURCE_LABEL[o.source]}` : ''} ready={!!data}>
      {o && (
        <>
          <PackSlip o={o} items={data.items.filter((i: any) => i.status === 'active')} notes={o.notes} />
          <div className="mt-4 grid grid-cols-2 gap-4 text-[13px]">
            <div><b>Customer</b><br />{data.customer.name}<br />{data.customer.phone ?? ''}<br />{data.customer.email ?? ''}</div>
            <div><b>Payment</b><br />{o.payment_status}{o.accounting_ref ? ` · ${o.accounting_ref}` : ''}</div>
          </div>
        </>
      )}
    </Page>
  );
}
