import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from './SiteChrome';

/** Header and footer for the customer pages (order page, order history, payment, help, about). */
export function PublicShell({ children, subtitle, wide }: { children: ReactNode; subtitle?: string; wide?: boolean }) {
  const width = wide ? 'max-w-5xl' : 'max-w-3xl';
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <SiteHeader subtitle={subtitle} width={width} />
      <main className={`mx-auto w-full min-w-0 flex-1 px-5 py-7 sm:px-8 sm:py-10 ${width}`}>{children}</main>
      <SiteFooter width={width} />
    </div>
  );
}
