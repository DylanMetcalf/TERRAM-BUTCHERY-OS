import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/order-bits';
import { api } from '../lib/api';

/**
 * Privacy notice for customers (Protection of Personal Information Act, 2013).
 * Plain language, filled in from the business details in Settings. The family should
 * read it through and adjust anything that doesn't match how they work.
 */
export default function PublicPrivacy() {
  const { data: info } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info') });
  const b = info?.business ?? {};
  const name: string = b.name ?? 'Terram Farm';
  useEffect(() => {
    document.title = `Privacy notice · ${name}`;
  }, [name]);
  const contact = [b.email, b.phone].filter(Boolean).join(' or ');
  return (
    <div className="min-h-dvh bg-bg">
      <header className="bg-charcoal text-white">
        <div className="mx-auto flex h-[72px] max-w-3xl items-center gap-3 px-5 sm:px-8">
          <Logo withWord={false} tone="light" />
          <span className="font-display text-[19px] font-bold">{name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <Link to="/order" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand"><ArrowLeft className="size-4" />Back to ordering</Link>
        <h1 className="mt-4 font-display text-[32px] font-bold leading-tight">Privacy notice</h1>
        <p className="mt-2 text-[15px] text-ink-3">How {name} looks after your personal information, in line with the Protection of Personal Information Act (POPIA).</p>

        <div className="mt-8 space-y-7 text-[15.5px] leading-relaxed text-ink-2">
          <Part title="Who we are">
            {name}, A Metcalf Family Farm{b.address ? `, ${b.address}` : ''}, is responsible for the personal information you give us. For anything about your information, contact us at {contact || 'the details on our website'}.
          </Part>
          <Part title="What we collect">
            When you order, we collect your name, phone number, email address (if you give it), delivery address, what you order and any notes you add. If you message or call us, we keep a record of that conversation with your order.
          </Part>
          <Part title="Why we use it">
            Only to take, prepare and deliver your orders, to contact you about them (for example to confirm an order, a delivery fee or a change), to invoice you, and to keep the records the law requires. We don’t sell your information, and we don’t send you marketing unless you’ve asked us to.
          </Part>
          <Part title="Who can see it">
            Our family team who handle orders, and the services we use to run them: our website and order system host, our email provider and our accounting software (for invoices). They may only use your information to provide those services to us. Some of these services store information outside South Africa, with protections comparable to POPIA.
          </Part>
          <Part title="How long we keep it">
            As long as we need it for your orders, and afterwards for as long as tax and accounting law requires (usually five years for invoices). You can ask us to delete information we no longer need.
          </Part>
          <Part title="Keeping it safe">
            Our order system is protected by passwords and encrypted connections, only our team can see orders, and we keep regular backups.
          </Part>
          <Part title="Your rights">
            You may ask what information we hold about you, ask us to correct or delete it, or object to how we use it. Contact us at {contact || 'the details on our website'}. If you’re not happy with our answer, you can complain to the Information Regulator (South Africa) at inforegulator.org.za.
          </Part>
        </div>
        <p className="mt-10 text-[13px] text-ink-3">Last updated September 2026.</p>
      </main>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-[19px] font-bold text-ink">{title}</h2>
      <p className="mt-1.5">{children}</p>
    </section>
  );
}
