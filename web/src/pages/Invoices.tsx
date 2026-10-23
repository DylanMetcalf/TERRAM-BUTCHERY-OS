import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, Receipt } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { INVOICE_TONE } from '../components/OrderPlatform';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Segmented } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, formatMoney, longDate } from '../lib/format';

/**
 * Invoice requests from customers. Invoices are prepared by hand in the accounting system;
 * this queue shows who asked, the billing details, and where each request is.
 */
export default function Invoices() {
  const [filter, setFilter] = useState<'outstanding' | 'done' | 'all'>('outstanding');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['invoices', filter], queryFn: () => api.get<{ requests: any[] }>(`/api/invoices?filter=${filter}`) });
  return (
    <div className="animate-rise">
      <PageHeader title="Invoice requests" subtitle="Prepare the invoice in your accounting software, then mark it issued or sent on the order." />
      <div className="mb-4 -mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'outstanding', label: 'To do' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]} />
      </div>
      {error ? <ErrorState error={error} retry={refetch} /> : isLoading || !data ? <LoadingBlock rows={4} /> : !data.requests.length ? (
        <EmptyState icon={<Receipt className="size-6" />} title={filter === 'outstanding' ? 'No invoices to prepare' : 'Nothing here yet'}>Customers can ask for an invoice when they order; staff can add a request on any order.</EmptyState>
      ) : (
        <Card className="divide-y divide-line">
          {data.requests.map((r) => {
            const d = r.invoice_details;
            const total = r.final_total_cents ?? r.estimated_total_cents;
            return (
              <Link key={r.id} to={`/orders/${r.id}`} className="flex items-start gap-3 px-4 py-3.5 hover:bg-surface-2 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">#{r.order_number} · {r.customer_name}</span>
                    <Badge size="sm" tone={INVOICE_TONE[r.invoice_status]}>{r.status_label}</Badge>
                    {!r.billing_complete && <Badge size="sm" tone="danger">Billing details incomplete</Badge>}
                  </div>
                  <div className="mt-0.5 text-[13.5px] text-ink-2">{d ? [d.billing_name, d.company, d.billing_email, d.vat_number && `VAT ${d.vat_number}`].filter(Boolean).join(' · ') : 'No billing details'}</div>
                  <div className="text-[12.5px] text-ink-3">
                    Requested {r.invoice_requested_at ? dateTime(r.invoice_requested_at) : '—'}
                    {r.invoice_ref ? ` · ${r.invoice_ref}` : ''}{r.invoice_issued_on ? ` · issued ${longDate(r.invoice_issued_on)}` : ''}
                    {total != null ? ` · ${r.final_total_cents != null ? '' : '≈ '}${formatMoney(total)}` : ''}
                    {r.assignee_name ? ` · ${r.assignee_name}` : ''}
                  </div>
                </div>
                {r.invoice_file_id && <FileText className="mt-1 size-4 shrink-0 text-field" aria-label="File attached" />}
                <ChevronRight className="mt-1 size-4 shrink-0 text-ink-3" />
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
