import { useQueryClient } from '@tanstack/react-query';
import { lazy as reactLazy, Suspense, useEffect, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { MeProvider, useMeQuery } from './lib/auth';
import { startRealtime } from './lib/realtime';
import { LoginPage } from './pages/Login';

/** After a new version is deployed, old code chunks disappear. Reload once to pick up the new build. */
function lazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return reactLazy(() =>
    load().catch((err) => {
      const key = 'terram:chunk-reload';
      try {
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          window.location.reload();
          return new Promise<never>(() => undefined);
        }
      } catch {
        /* storage unavailable */
      }
      throw err;
    }),
  );
}
if (typeof window !== 'undefined') window.addEventListener('load', () => setTimeout(() => { try { sessionStorage.removeItem('terram:chunk-reload'); } catch { /* ignore */ } }, 5000));

const Today = lazy(() => import('./pages/Today'));
const Orders = lazy(() => import('./pages/Orders'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const NewOrder = lazy(() => import('./pages/NewOrder'));
const ImportPage = lazy(() => import('./pages/Import'));
const Cutting = lazy(() => import('./pages/Cutting'));
const Packing = lazy(() => import('./pages/Packing'));
const Fulfilment = lazy(() => import('./pages/Fulfilment'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Products = lazy(() => import('./pages/Products'));
const Exceptions = lazy(() => import('./pages/Exceptions'));
const Intelligence = lazy(() => import('./pages/Intelligence'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const PrintView = lazy(() => import('./print/Print'));
const PublicOrder = lazy(() => import('./pages/PublicOrder'));

function FullSpinner() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

export function App() {
  const loc = useLocation();
  if (loc.pathname === '/order' || loc.pathname.startsWith('/order/')) {
    return (
      <Suspense fallback={<FullSpinner />}>
        <Routes>
          <Route path="/order/*" element={<PublicOrder />} />
        </Routes>
      </Suspense>
    );
  }
  return <InternalApp />;
}

function InternalApp() {
  const { data: me, isLoading, error, refetch } = useMeQuery();
  const qc = useQueryClient();
  const signedIn = !!me?.user;
  useEffect(() => {
    if (!signedIn) return;
    return startRealtime(qc);
  }, [signedIn, qc]);

  if (isLoading) return <FullSpinner />;
  if (error || !me)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-display text-xl">Can’t reach Terram right now.</p>
        <p className="text-ink-2">Check the internet connection and try again.</p>
        <button className="font-medium text-brand underline" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );
  if (!me.user) return <LoginPage setup={me.needs_setup} />;

  return (
    <MeProvider me={me}>
      <Routes>
        <Route path="/print/*" element={<Suspense fallback={<FullSpinner />}><PrintView /></Suspense>} />
        <Route
          path="*"
          element={
            <Shell>
              <Suspense fallback={<FullSpinner />}>
                <Routes>
                  <Route path="/" element={<Today />} />
                  <Route path="/orders" element={<Orders />} />
                  <Route path="/orders/new" element={<NewOrder />} />
                  <Route path="/orders/:id" element={<OrderDetail />} />
                  <Route path="/import" element={<ImportPage />} />
                  <Route path="/import/:id" element={<ImportPage />} />
                  <Route path="/cutting" element={<Cutting />} />
                  <Route path="/packing" element={<Packing />} />
                  <Route path="/fulfilment" element={<Fulfilment />} />
                  <Route path="/customers" element={<Customers />} />
                  <Route path="/customers/:id" element={<CustomerDetail />} />
                  <Route path="/products" element={<Products />} />
                  <Route path="/exceptions" element={<Exceptions />} />
                  <Route path="/intelligence" element={<Intelligence />} />
                  <Route path="/reports" element={<Reports />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/login" element={<Navigate to="/" replace />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </Shell>
          }
        />
      </Routes>
    </MeProvider>
  );
}

function NotFound() {
  return (
    <div className="py-24 text-center">
      <p className="font-display text-2xl">This page doesn’t exist.</p>
      <a href="/" className="mt-3 inline-block font-medium text-brand underline">
        Back to today
      </a>
    </div>
  );
}
