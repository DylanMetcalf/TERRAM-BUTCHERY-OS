import { Mail, MessageCircle, Phone } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input, Sheet } from './ui';

/**
 * How a customer changes an order they've already sent: WhatsApp, a call or an email to the
 * family, with the reference number filled in. Changes are then made by staff in Terram,
 * so nothing already cut or packed changes behind anyone's back.
 */
export function ChangeOrderButtons({ phone, email, reference, name }: { phone?: string; email?: string; reference?: number | string | null; name?: string }) {
  const wa = (phone ?? '').replace(/\D/g, '').replace(/^0/, '27');
  const ref = reference ? `#${String(reference).replace(/^#/, '')}` : '';
  const text = `Hi${name ? `, it's ${name}` : ''}. I'd like to change my order${ref ? ` ${ref}` : ''}: `;
  const btn = 'inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink transition hover:border-ink-3';
  return (
    <div className="flex flex-wrap gap-2">
      {wa && <a className={btn} href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer"><MessageCircle className="size-4 text-[#1f9d55]" />WhatsApp</a>}
      {phone && <a className={btn} href={`tel:${phone.replace(/\s/g, '')}`}><Phone className="size-4" />Call</a>}
      {email && <a className={btn} href={`mailto:${email}?subject=${encodeURIComponent(`Change to my order ${ref}`.trim())}&body=${encodeURIComponent(text)}`}><Mail className="size-4" />Email</a>}
    </div>
  );
}

/** "Need to change an order you've already sent?" link + sheet asking for the reference number. */
export function ChangeOrderLink({ phone, email, className }: { phone?: string; email?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? 'text-[14px] font-medium text-brand underline-offset-2 hover:underline'}>
        Need to change an order you’ve already sent?
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Change an order" footer={<Button full size="lg" variant="ghost" onClick={() => setOpen(false)}>Close</Button>}>
        <div className="space-y-4">
          <p className="text-[15px] text-ink-2">Let us know what you’d like to change and we’ll update your order. Your reference number is in your confirmation email and on the screen after you sent the order.</p>
          <Field label="Order reference" optional htmlFor="change-ref">
            <Input id="change-ref" inputMode="numeric" value={ref} onChange={(e) => setRef(e.target.value.replace(/[^\d]/g, '').slice(0, 8))} placeholder="e.g. 1042" className="w-40" />
          </Field>
          <ChangeOrderButtons phone={phone} email={email} reference={ref || null} />
        </div>
      </Sheet>
    </>
  );
}
