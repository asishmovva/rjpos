'use client';
import { useEffect, useState } from 'react';

/**
 * Support contact details come from build-time configuration so they can change per deployment without code edits.
 * Anything not configured says so; nothing is invented. Operator screens only: never render this on the customer display.
 */
export const supportConfig = {
  phone: process.env.NEXT_PUBLIC_RJPOS_SUPPORT_PHONE ?? '',
  email: process.env.NEXT_PUBLIC_RJPOS_SUPPORT_EMAIL ?? '',
  website: process.env.NEXT_PUBLIC_RJPOS_SUPPORT_WEBSITE ?? '',
};
const row = (label: string, value: string, href?: string) => <div className="support-row"><span>{label}</span>{value ? (href ? <a href={href}>{value}</a> : <strong>{value}</strong>) : <em>Not configured yet</em>}</div>;

export function SupportButton({ className = 'support-btn' }: { className?: string }): React.ReactNode {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog">Help</button>
    {open && <div className="modal" role="dialog" aria-modal="true" aria-label="RJ POS Support" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="utility-modal support-modal">
        <button className="close" aria-label="Close" onClick={() => setOpen(false)}>×</button>
        <h2>RJ POS Support</h2><p className="support-badge">24/7 Support</p>
        {row('Phone', supportConfig.phone, supportConfig.phone ? `tel:${supportConfig.phone.replace(/[^\d+]/g, '')}` : undefined)}
        {row('Email', supportConfig.email, supportConfig.email ? `mailto:${supportConfig.email}` : undefined)}
        {row('Website', supportConfig.website, supportConfig.website && /^https?:\/\//.test(supportConfig.website) ? supportConfig.website : undefined)}
        <p className="hint">Have your store name and the time the problem happened ready. Do not share PINs.</p>
      </section></div>}
  </>;
}
