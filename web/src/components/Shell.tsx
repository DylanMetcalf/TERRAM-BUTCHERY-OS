import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  BarChart3,
  Beef,
  ClipboardList,
  Home,
  LogOut,
  Menu,
  MessageSquarePlus,
  Package,
  PenLine,
  Plus,
  Scissors,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Truck,
  Users,
  WifiOff,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useCan, useMe } from '../lib/auth';
import { useConnection } from '../lib/realtime';
import type { Permission } from '../lib/types';
import { ROLE_LABEL } from '../../../shared/permissions';
import { CommandSearch } from './CommandSearch';
import { Logo } from './order-bits';
import { Avatar, CountBubble, cx, Kbd, Sheet } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Home;
  perm?: Permission;
  badge?: 'attention' | 'review';
}

const PRIMARY: NavItem[] = [
  { to: '/', label: 'Today', icon: Home },
  { to: '/orders', label: 'Orders', icon: ClipboardList, badge: 'review' },
  { to: '/cutting', label: 'Cutting', icon: Scissors },
  { to: '/packing', label: 'Packing', icon: Package },
  { to: '/fulfilment', label: 'Fulfilment', icon: Truck },
];
const SECONDARY: NavItem[] = [
  { to: '/customers', label: 'Customers', icon: Users, perm: 'customers.read' },
  { to: '/products', label: 'Products', icon: Beef, perm: 'products.read' },
];
const TERTIARY: NavItem[] = [
  { to: '/exceptions', label: 'Needs attention', icon: AlertCircle, badge: 'attention' },
  { to: '/intelligence', label: 'Intelligence', icon: Sparkles, perm: 'intelligence.read' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: 'reports.read' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: 'settings.read' },
];

export function useNavCounts() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<any>('/api/production/dashboard'),
    staleTime: 20_000,
    select: (d) => ({ attention: d.exceptions.total as number, review: d.counts.to_review as number, blocking: d.exceptions.blocking as number }),
  });
}

function ConnectionDot() {
  const s = useConnection();
  if (s === 'live') return <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3"><span className="size-2 rounded-full bg-field shadow-[0_0_0_3px_var(--field-soft)]" />Live</span>;
  if (s === 'offline')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-medium text-danger-soft-ink">
        <WifiOff className="size-3.5" /> Offline
      </span>
    );
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3"><span className="size-2 animate-pulse rounded-full bg-ochre" />Connecting</span>;
}

function OfflineBanner() {
  const s = useConnection();
  if (s !== 'offline') return null;
  return (
    <div className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-danger px-4 py-2 text-center text-[13px] font-medium text-white" role="status">
      <WifiOff className="size-4" /> You’re offline. You can keep reading, but changes can’t be saved until the connection is back.
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const can = useCan();
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: counts } = useNavCounts();
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => {
    setMoreOpen(false);
    setAddOpen(false);
  }, [loc.pathname]);

  const badge = (b?: NavItem['badge']) => (b === 'attention' ? counts?.attention ?? 0 : b === 'review' ? counts?.review ?? 0 : 0);
  const visible = (items: NavItem[]) => items.filter((i) => !i.perm || can(i.perm));
  const signOut = async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    window.location.href = '/';
  };

  const SideLink = ({ item }: { item: NavItem }) => (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cx(
          'group flex h-10 items-center gap-3 rounded-xl px-3 text-[14.5px] font-medium transition',
          isActive ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className={cx('size-[18px] shrink-0', isActive ? 'text-brand' : 'text-ink-3 group-hover:text-ink-2')} />
          <span className="flex-1 truncate">{item.label}</span>
          <CountBubble n={badge(item.badge)} tone={item.badge === 'attention' ? 'brand' : 'neutral'} />
        </>
      )}
    </NavLink>
  );

  return (
    <div className="min-h-dvh lg:pl-[256px]">
      <OfflineBanner />
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[256px] flex-col border-r border-line bg-sunken/60 px-3 pb-4 pt-5 lg:flex">
        <Link to="/" className="mb-6 px-2">
          <Logo />
        </Link>
        {can('orders.write') && (
          <button onClick={() => setAddOpen(true)} className="mb-5 flex h-11 items-center justify-center gap-2 rounded-xl bg-brand text-[14.5px] font-semibold text-brand-ink shadow-card transition hover:bg-brand-hover active:scale-[0.98]">
            <Plus className="size-4" strokeWidth={2.5} /> New order
          </button>
        )}
        <nav className="flex-1 space-y-5 overflow-y-auto" aria-label="Main">
          <div className="space-y-0.5">{visible(PRIMARY).map((i) => <SideLink key={i.to} item={i} />)}</div>
          <div className="space-y-0.5">{visible(SECONDARY).map((i) => <SideLink key={i.to} item={i} />)}</div>
          <div className="space-y-0.5">{visible(TERTIARY).map((i) => <SideLink key={i.to} item={i} />)}</div>
        </nav>
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center gap-3 px-2">
            <Avatar name={me.user!.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium">{me.user!.name}</div>
              <div className="text-[12px] text-ink-3">{ROLE_LABEL[me.user!.role]}</div>
            </div>
            <Link to="/devices" className="rounded-lg p-2 text-ink-3 hover:bg-surface hover:text-ink" aria-label="Add a device" title="Add a device">
              <Smartphone className="size-4" />
            </Link>
            <button onClick={signOut} className="rounded-lg p-2 text-ink-3 hover:bg-surface hover:text-ink" aria-label="Sign out" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Top bar */}
      <header className="safe-top sticky top-0 z-20 border-b border-line/70 bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:h-16 lg:px-8">
          <Link to="/" className="lg:hidden" aria-label="Today">
            <Logo withWord={false} />
          </Link>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-line bg-surface px-3 text-left text-[14px] text-ink-3 shadow-card transition hover:border-line-strong sm:max-w-md"
          >
            <Search className="size-4 shrink-0" />
            <span className="flex-1 truncate">Search orders, customers, products…</span>
            <span className="hidden sm:inline"><Kbd>⌘K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden sm:inline-flex"><ConnectionDot /></span>
            <button onClick={() => setMoreOpen(true)} className="rounded-xl p-2 text-ink-2 hover:bg-sunken lg:hidden" aria-label="Menu">
              <Menu className="size-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-16">{children}</main>

      {/* Mobile bottom navigation */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-md lg:hidden" aria-label="Main">
        <div className="mx-auto grid h-[68px] max-w-lg grid-cols-5 items-center px-2">
          <BottomLink to="/" icon={Home} label="Today" />
          <BottomLink to="/orders" icon={ClipboardList} label="Orders" count={counts?.review} />
          <div className="flex justify-center">
            {can('orders.write') ? (
              <button onClick={() => setAddOpen(true)} className="flex size-14 -translate-y-3 items-center justify-center rounded-2xl bg-brand text-brand-ink shadow-float transition active:scale-95" aria-label="Add order">
                <Plus className="size-7" strokeWidth={2.4} />
              </button>
            ) : (
              <BottomLink to="/cutting" icon={Scissors} label="Cutting" />
            )}
          </div>
          <BottomLink to="/exceptions" icon={AlertCircle} label="Attention" count={counts?.attention} />
          <button onClick={() => setMoreOpen(true)} className={cx('flex flex-col items-center gap-1 py-1 text-[11px] font-medium', ['/cutting', '/packing', '/fulfilment', '/customers', '/products', '/intelligence', '/reports', '/settings'].some((p) => loc.pathname.startsWith(p)) ? 'text-brand' : 'text-ink-3')}>
            <Menu className="size-[22px]" />
            More
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Menu">
        <div className="grid grid-cols-3 gap-2">
          {visible([...PRIMARY.slice(2), ...SECONDARY, ...TERTIARY]).map((i) => (
            <Link key={i.to} to={i.to} className={cx('flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 text-center text-[13px] font-medium', loc.pathname.startsWith(i.to) ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line bg-surface text-ink')}>
              <i.icon className="size-6" />
              {i.label}
            </Link>
          ))}
        </div>
        <Link to="/devices" className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-[14.5px] font-medium">
          <Smartphone className="size-5 text-brand" /> Add Terram to another phone or computer
        </Link>
        <div className="mt-4 flex items-center justify-between rounded-2xl bg-sunken px-4 py-3">
          <div className="flex items-center gap-3">
            <Avatar name={me.user!.name} />
            <div>
              <div className="font-medium">{me.user!.name}</div>
              <div className="text-[13px] text-ink-3">{ROLE_LABEL[me.user!.role]} · <ConnectionDot /></div>
            </div>
          </div>
          <button onClick={signOut} className="rounded-xl px-3 py-2 text-[14px] font-medium text-ink-2 hover:bg-surface">
            Sign out
          </button>
        </div>
      </Sheet>

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add an order" subtitle="Every order goes into the same place, however it arrives.">
        <div className="space-y-2.5">
          <AddChoice icon={<MessageSquarePlus className="size-6" />} title="Paste orders" body="From WhatsApp, SMS or email — one message or a whole chat. We’ll read it and show you what we understood before anything is saved." onClick={() => navigate('/import')} />
          <AddChoice icon={<PenLine className="size-6" />} title="Type an order" body="Phone call or walk-in — pick the customer and products." onClick={() => navigate('/orders/new')} />
        </div>
      </Sheet>

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function AddChoice({ icon, title, body, onClick }: { icon: ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-start gap-4 rounded-2xl border border-line bg-surface p-4 text-left transition hover:border-line-strong hover:bg-surface-2 active:scale-[0.99]">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">{icon}</span>
      <span>
        <span className="block text-[16px] font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-[14px] text-ink-2">{body}</span>
      </span>
    </button>
  );
}

function BottomLink({ to, icon: Icon, label, count }: { to: string; icon: typeof Home; label: string; count?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => cx('relative flex flex-col items-center gap-1 py-1 text-[11px] font-medium', isActive ? 'text-brand' : 'text-ink-3')}>
      <span className="relative">
        <Icon className="size-[22px]" />
        {!!count && <span className="absolute -right-2.5 -top-1.5"><CountBubble n={count} /></span>}
      </span>
      {label}
    </NavLink>
  );
}
