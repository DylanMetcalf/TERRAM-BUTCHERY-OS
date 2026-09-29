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

/** The farm's logo for paper: the uploaded one if there is one, otherwise Terram's own. */
function PrintLogo({ className }: { className?: string }) {
  const { data: brand } = useBrand();
  if (!brand) return null;
  return <img src={brand.hasLogo ? `/brand/logo?v=${brand.version}` : '/brand/terram-logo.png'} alt="" className={className ?? 'h-12 w-auto max-w-[120px] object-contain'} />;
}

function Page({ title, subtitle, children, ready, bare, tools }: { title: string; subtitle?: string; children: ReactNode; ready: boolean; bare?: boolean; tools?: ReactNode }) {
  const me = useMe();
  useEffect(() => {
    document.title = `${title} — ${me.business.name}`;
    if (ready) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [ready, title, me.business.name]);
  return (
    <div className="min-h-dvh bg-white text-black">
      <style>{`@page { size: A4; margin: 11mm; } html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } @media print { .no-print { display: none !important; } .break { break-after: page; } .avoid { break-inside: avoid; } }`}</style>
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-6 py-3 text-[14px]">
        <span className="text-neutral-600">Print preview</span>
        <div className="flex flex-wrap items-center gap-2">
          {tools}
          <button onClick={() => window.close()} className="rounded-lg border border-neutral-300 px-3 py-1.5">Close</button>
          <button onClick={() => window.print()} className="rounded-lg bg-black px-4 py-1.5 font-medium text-white">Print</button>
        </div>
      </div>
      <div className="mx-auto max-w-[780px] px-6 py-6 print:max-w-none print:p-0">
        {!bare && (
          <header className="mb-5 flex items-end justify-between border-b-2 border-black pb-2">
            <div className="flex items-end gap-3">
              <PrintLogo />
              <div>
                <div className="text-[11px] font-semibold tracking-[0.04em]">{me.business.name} · Butchery</div>
                <h1 className="font-display text-[20px] font-bold leading-tight">{title}</h1>
                {subtitle && <div className="text-[13px]">{subtitle}</div>}
              </div>
            </div>
            <div className="text-right text-[11px]">Printed {dateTime(new Date().toISOString())}<br />by {me.user?.name}</div>
          </header>
        )}
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
      {cats.length > 0 && (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b-2 border-black text-left text-[10.5px] font-semibold">
              <th className="w-6 py-1" />
              <th className="py-1 pr-2">Product</th>
              <th className="w-[92px] py-1 pr-2 text-right">To cut</th>
              <th className="py-1 pr-2">For</th>
              <th className="w-[30%] py-1">Notes</th>
            </tr>
          </thead>
          {cats.map((cat) => (
            <tbody key={cat} className="avoid">
              <tr>
                <td colSpan={5} className="pb-0.5 pt-3 text-[12.5px] font-bold">{cat}</td>
              </tr>
              {data.lines.filter((l: any) => l.category === cat).map((l: any) => (
                <tr key={l.key} className="avoid border-t border-neutral-400 align-top">
                  <td className="py-1.5 pr-1.5"><span className="mt-0.5 inline-block size-3.5 border-[1.5px] border-black" /></td>
                  <td className="py-1.5 pr-2">
                    <div className="text-[13px] font-bold leading-tight">{l.product_name}</div>
                    {l.preparation_label && <div className="text-[11.5px] font-semibold">{l.preparation_label}</div>}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right">
                    <div className="text-[14px] font-bold leading-tight">{l.total_label}</div>
                    {l.estimate_label && <div className="text-[10px]">{l.estimate_label}</div>}
                  </td>
                  <td className="py-1.5 pr-2 text-[11px] leading-snug">
                    {l.orders.map((o: any) => (
                      <div key={o.item_id}>{o.customer_name} {o.qty_label}{o.special_instructions ? <b> — {o.special_instructions}</b> : null}</div>
                    ))}
                  </td>
                  <td className="py-1.5"><div className="mt-3.5 border-b border-dotted border-neutral-500" /></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
      {data && (
        <section className="avoid mt-6">
          <h2 className="text-[12.5px] font-bold">Notes</h2>
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-7 border-b border-neutral-400" />)}
          <div className="mt-4 flex justify-between text-[11px]"><span>Cut by: ____________________</span><span>Checked: ____________</span></div>
        </section>
      )}
    </Page>
  );
}

const cell = 'border border-neutral-400 px-2 py-1.5 align-top';
const head = 'border border-neutral-400 bg-neutral-100 px-2 py-1 text-left text-[9.5px] font-bold uppercase tracking-[0.06em] text-neutral-700';

function Box({ done }: { done?: boolean }) {
  return <span className={`inline-flex size-[15px] items-center justify-center border-[1.5px] border-black text-[11px] font-bold leading-none ${done ? 'bg-black text-white' : ''}`}>{done ? '✓' : ''}</span>;
}

function Lines({ n, className }: { n: number; className?: string }) {
  return <div className={className}>{Array.from({ length: n }).map((_, i) => <div key={i} className="h-[22px] border-b border-neutral-400" />)}</div>;
}

/**
 * The order docket: one per order, for the blockman to work from and write on. Logo and order
 * details up top; a line per item with the customer's instructions, tick boxes for cut and packed,
 * a space for the actual weight and the blockman's own notes; notes and sign-off at the bottom.
 */
function Docket({ o, items, notes, business, onePerPage }: { o: OrderSummary; items: OrderItem[]; notes?: string | null; business?: any; onePerPage?: boolean }) {
  const today = todayYmd();
  const me = useMe();
  const how = o.fulfilment_type === 'delivery' ? 'Delivery' : o.fulfilment_type === 'collection' ? 'Collection' : 'Collection or delivery';
  const address = o.fulfilment_type !== 'collection' ? o.delivery_address : null;
  const phone = o.contact_phone ?? o.customer_phone;
  return (
    <article className={`avoid mb-6 border-2 border-black text-[12px] leading-snug ${onePerPage ? 'break' : ''}`}>
      {/* Header */}
      <header className="flex items-stretch justify-between gap-4 border-b-2 border-black">
        <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
          <PrintLogo className="h-11 w-auto max-w-[110px] object-contain" />
          <div className="min-w-0">
            <div className="font-display text-[16px] font-bold leading-tight">{business?.name ?? me.business.name}</div>
            <div className="text-[10.5px] text-neutral-700">{[business?.phone, business?.email].filter(Boolean).join(' · ') || 'Butchery'}</div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center bg-[var(--brand,#446041)] px-4 py-2 text-white">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.14em] opacity-90">Order docket</div>
          <div className="font-display text-[26px] font-extrabold leading-none">#{o.order_number}</div>
        </div>
      </header>

      {/* Who, how, when */}
      <div className="grid grid-cols-[1.3fr_1.3fr_1fr_0.9fr] border-b border-black">
        <div className="border-r border-neutral-400 px-3 py-2">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-neutral-600">Customer</div>
          <div className="text-[15px] font-bold leading-tight">{o.customer_name}</div>
          {phone && <div>{phone}</div>}
        </div>
        <div className="border-r border-neutral-400 px-3 py-2">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-neutral-600">{how}</div>
          {address ? <div className="whitespace-pre-line">{address}</div> : <div>{o.fulfilment_type === 'collection' ? 'Collecting from the shop' : 'To be arranged'}</div>}
          {o.delivery_km != null && <div className="text-[11px] text-neutral-700">{o.delivery_km} km</div>}
        </div>
        <div className="border-r border-neutral-400 px-3 py-2">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-neutral-600">Wanted</div>
          <div className="text-[14px] font-bold leading-tight">{o.requested_date ? longDate(o.requested_date) : 'No date'}</div>
          <div className="text-[11px]">{o.requested_date ? friendlyDate(o.requested_date, today) : ''}{o.time_window ? ` · ${o.time_window}` : ''}</div>
        </div>
        <div className="px-3 py-2">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-neutral-600">Order</div>
          <div className="font-semibold">{STATUS_LABEL[o.status]}</div>
          <div className="text-[11px] text-neutral-700">{SOURCE_LABEL[o.source]} · {dateTime(o.created_at)}</div>
        </div>
      </div>

      {/* Items */}
      <div className="p-2.5">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={`${head} w-[34px] text-center`}>Cut</th>
              <th className={`${head} w-[80px]`}>Qty</th>
              <th className={head}>Product &amp; preparation</th>
              <th className={`${head} w-[26%]`}>Customer’s instructions</th>
              <th className={`${head} w-[62px] text-center`}>Weight kg</th>
              <th className={`${head} w-[38px] text-center`}>Packed</th>
              <th className={`${head} w-[22%]`}>Blockman notes</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="avoid">
                <td className={`${cell} text-center`}><Box done={!!i.cut_at} /></td>
                <td className={`${cell} whitespace-nowrap text-[13.5px] font-bold`}>{qtyBeforeName(i.qty)}</td>
                <td className={cell}>
                  <div className="text-[13px] font-bold leading-tight">{i.product_name}</div>
                  {i.preparation_label && <div className="text-[11.5px]">{i.preparation_label}</div>}
                </td>
                <td className={`${cell} text-[11.5px]`}>{i.special_instructions ? <b>{i.special_instructions}</b> : <span className="text-neutral-400">—</span>}</td>
                <td className={`${cell} text-center text-[12px] font-semibold`}>{i.packed_weight_g ? (i.packed_weight_g / 1000).toFixed(2) : ''}</td>
                <td className={`${cell} text-center`}><Box done={!!i.packed_at} /></td>
                <td className={cell} />
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={7} className={`${cell} text-neutral-600`}>No items yet{o.special_request ? ' — see the special request below.' : '.'}</td></tr>
            )}
            {/* Spare lines for anything added at the counter */}
            {Array.from({ length: items.length < 6 ? 2 : 1 }).map((_, k) => (
              <tr key={`spare${k}`}>
                <td className={`${cell} h-[26px] text-center`}><Box /></td>
                <td className={cell} /><td className={cell} /><td className={cell} /><td className={cell} />
                <td className={`${cell} text-center`}><Box /></td>
                <td className={cell} />
              </tr>
            ))}
          </tbody>
        </table>

        {(o.special_request || notes || o.delivery_notes) && (
          <div className="mt-2.5 space-y-1.5">
            {o.special_request && <div className="border-l-4 border-black bg-neutral-100 px-2.5 py-1.5"><b>Special request:</b> {o.special_request}</div>}
            {notes && <div className="border-l-4 border-black bg-neutral-100 px-2.5 py-1.5"><b>Customer’s note:</b> {notes}</div>}
            {o.delivery_notes && <div className="border-l-4 border-neutral-500 bg-neutral-100 px-2.5 py-1.5"><b>Delivery note:</b> {o.delivery_notes}</div>}
          </div>
        )}

        <div className="mt-3 grid grid-cols-[1fr_210px] gap-4">
          <div>
            <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-neutral-600">Notes · extra stock needed</div>
            <Lines n={3} />
          </div>
          <div className="space-y-2.5 text-[11.5px]">
            <div className="flex items-end justify-between gap-2"><span>Total weight</span><span className="w-24 border-b border-black text-right">kg</span></div>
            <div className="flex items-end justify-between gap-2"><span>Cut by</span><span className="w-32 border-b border-black" /></div>
            <div className="flex items-end justify-between gap-2"><span>Packed by</span><span className="w-32 border-b border-black" /></div>
            <div className="flex items-end justify-between gap-2"><span>Checked</span><span className="w-32 border-b border-black" /></div>
          </div>
        </div>
      </div>
    </article>
  );
}

function useBusiness() {
  return useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info'), select: (d) => d.business, staleTime: 5 * 60_000 }).data;
}

function OnePerPageToggle() {
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const on = params.get('per') === 'page';
  if (on) params.delete('per');
  else params.set('per', 'page');
  return (
    <a href={`${loc.pathname}?${params}`} className="rounded-lg border border-neutral-300 px-3 py-1.5">
      {on ? 'Several per page' : 'One per page'}
    </a>
  );
}

function PackingPrint() {
  const loc = useLocation();
  const onePerPage = new URLSearchParams(loc.search).get('per') === 'page';
  const business = useBusiness();
  const { data } = useQuery({ queryKey: ['packing', 'print'], queryFn: () => api.get<any>('/api/production/packing') });
  return (
    <Page title="Packing slips" subtitle={data ? `${data.ready_to_pack.length} orders ready to pack` : ''} ready={!!data} bare tools={<OnePerPageToggle />}>
      {data && !data.ready_to_pack.length && <p>Nothing to pack.</p>}
      {data?.ready_to_pack.map((o: any) => <Docket key={o.id} o={o} items={o.items} notes={o.notes} business={business} onePerPage={onePerPage} />)}
    </Page>
  );
}

function DocketsPrint() {
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const date = params.get('date');
  const onePerPage = params.get('per') === 'page';
  const business = useBusiness();
  const { data } = useQuery({ queryKey: ['dockets', date], queryFn: () => api.get<any>(`/api/production/dockets${qs({ date })}`) });
  return (
    <Page title="Order dockets" subtitle={data ? `${date ? longDate(date) : 'All open orders'} · ${data.orders.length} orders` : ''} ready={!!data} bare tools={<OnePerPageToggle />}>
      {data && !data.orders.length && <p>No confirmed orders for this day.</p>}
      {data?.orders.map((o: any) => <Docket key={o.id} o={o} items={o.items.filter((i: any) => i.status === 'active')} notes={o.notes} business={business} onePerPage={onePerPage} />)}
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
  const business = useBusiness();
  const { data } = useQuery({ queryKey: ['order', id, 'print'], queryFn: () => api.get<any>(`/api/orders/${id}`) });
  const o = data?.order as OrderSummary | undefined;
  return (
    <Page title={o ? `Order #${o.order_number}` : 'Order'} ready={!!data} bare>
      {o && (
        <>
          <Docket o={o} items={data.items.filter((i: any) => i.status === 'active')} notes={o.notes} business={business} />
          <div className="text-right text-[10.5px] text-neutral-600">Printed {dateTime(new Date().toISOString())}</div>
        </>
      )}
    </Page>
  );
}
