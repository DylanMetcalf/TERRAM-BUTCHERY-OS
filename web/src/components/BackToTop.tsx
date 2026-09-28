import { ArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cx } from './ui';

/** Round "back to top" button that appears once the visitor has scrolled down a long page. */
export function BackToTop({ className }: { className?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 700);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
      className={cx(
        'fixed right-4 z-30 flex size-12 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-float transition sm:right-6',
        show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
        className ?? 'bottom-6',
      )}
    >
      <ArrowUp className="size-5" />
    </button>
  );
}
