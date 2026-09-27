import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { ExceptionCard } from '../components/ExceptionCard';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Segmented } from '../components/ui';
import { api } from '../lib/api';
import type { ExceptionRow } from '../lib/types';

export default function Exceptions() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [kind, setKind] = useState<'all' | 'blocking' | 'other'>('all');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['exceptions', status], queryFn: () => api.get<{ exceptions: ExceptionRow[]; counts: { total: number; blocking: number } }>(`/api/exceptions?status=${status === 'open' ? 'open' : 'all'}`) });
  const list = (data?.exceptions ?? [])
    .filter((e) => (status === 'open' ? e.status === 'open' : e.status !== 'open'))
    .filter((e) => (kind === 'all' ? true : kind === 'blocking' ? e.severity === 'blocking' : e.severity !== 'blocking'));
  return (
    <div className="animate-rise">
      <PageHeader title="Needs attention" subtitle="Things the system won’t guess. Each one needs a quick decision from a person." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: 'To decide', count: data?.counts.total }, { value: 'resolved', label: 'Done' }]} />
        {status === 'open' && (data?.counts.total ?? 0) > 0 && (
          <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'blocking', label: 'Holding up orders', count: data?.counts.blocking }, { value: 'other', label: 'Other' }]} />
        )}
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock rows={3} />
      ) : !list.length ? (
        status === 'open' ? (
          <EmptyState icon={<CheckCircle2 className="size-7" />} tone="field" title="No exceptions">Everything is under control.</EmptyState>
        ) : (
          <EmptyState title="Nothing resolved yet">Decisions you make will be listed here.</EmptyState>
        )
      ) : (
        <div className="mx-auto max-w-3xl space-y-3">
          {list.map((e) => (
            <ExceptionCard key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}
