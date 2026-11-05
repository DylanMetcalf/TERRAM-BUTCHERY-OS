import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader, usePublicInfo } from './SiteChrome';
import { ReviewBubble } from './Social';

/** Header and footer for the customer pages (order page, order history, payment, help, about). */
/** `reviewBubble`: show the Google review bubble (website pages only, not order or payment pages). */
export function PublicShell({ children, subtitle, wide, reviewBubble }: { children: ReactNode; subtitle?: string; wide?: boolean; reviewBubble?: boolean }) {
  const width = wide ? 'max-w-5xl' : 'max-w-3xl';
  const { data: info } = usePublicInfo();
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <SiteHeader subtitle={subtitle} width={width} />
      <main className={`mx-auto w-full min-w-0 flex-1 px-5 py-7 sm:px-8 sm:py-10 ${width}`}>{children}</main>
      <SiteFooter width={width} />
      {reviewBubble && <ReviewBubble url={info?.business?.googleReviewUrl} name={info?.business?.name ?? 'Terram Farm'} />}
    </div>
  );
}
