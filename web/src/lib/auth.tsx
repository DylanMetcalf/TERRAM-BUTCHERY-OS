import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api } from './api';
import type { Me, Permission } from './types';

const Ctx = createContext<Me | null>(null);

export function useMeQuery() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me'), staleTime: 60_000, retry: 1 });
}

export function MeProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  useEffect(() => {
    const h = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('terram:unauthenticated', h);
    return () => window.removeEventListener('terram:unauthenticated', h);
  }, [qc]);
  return <Ctx.Provider value={me}>{children}</Ctx.Provider>;
}

export function useMe(): Me {
  const me = useContext(Ctx);
  if (!me) throw new Error('useMe outside provider');
  return me;
}

export function useCan() {
  const me = useMe();
  return (p: Permission) => !!me.user?.permissions.includes(p);
}
