import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { Button, Card, Spinner } from '../components/ui';
import { api } from '../lib/api';

/** From the link at the bottom of a reminder email. Order updates are not affected. */
export default function Unsubscribe() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const key = ['unsubscribe', token];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ first_name: string; subscribed: boolean }>(`/api/public/unsubscribe/${token}`), retry: false });
  const set = useMutation({ mutationFn: (subscribed: boolean) => api.post<{ subscribed: boolean }>(`/api/public/unsubscribe/${token}`, { subscribed }), onSuccess: (r) => qc.setQueryData(key, { ...data!, subscribed: r.subscribed }) });
  return (
    <PublicShell subtitle="Email preferences">
      <Card className="mx-auto max-w-md p-6 text-center">
        {error ? (
          <p className="text-ink-2">This link isn’t valid. You can manage reminders after signing in on the “Your orders” page.</p>
        ) : !data ? (
          <Spinner />
        ) : data.subscribed ? (
          <>
            <h1 className="font-display text-2xl font-semibold">Stop reorder reminders?</h1>
            <p className="mt-2 text-ink-2">Hi {data.first_name}, you’ll still get emails about orders you place.</p>
            <Button className="mt-5" size="lg" variant="primary" loading={set.isPending} onClick={() => set.mutate(false)}>Unsubscribe from reminders</Button>
          </>
        ) : (
          <>
            <h1 className="font-display text-2xl font-semibold">You’re unsubscribed</h1>
            <p className="mt-2 text-ink-2">We won’t send you reorder reminders. You’ll still get emails about orders you place.</p>
            <Button className="mt-5" variant="ghost" loading={set.isPending} onClick={() => set.mutate(true)}>Changed your mind? Turn reminders back on</Button>
          </>
        )}
      </Card>
    </PublicShell>
  );
}
