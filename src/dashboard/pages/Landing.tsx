import { useEffect, useState } from 'react';
import { Logo } from '../components/Logo';
import { api, type PlanInfo } from '../lib/api';

export const GITHUB_URL = 'https://github.com/surendrapandar/minilytics';

export function usePlan() {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  useEffect(() => {
    api<PlanInfo>('/api/public/plan').then(setPlan, () => {});
  }, []);
  return plan;
}

export function priceLabel(p: PlanInfo | null) {
  if (!p) return '';
  return p.interval === 'lifetime' ? `${p.price} one-time` : `${p.price}/${p.interval}`;
}

export function GoogleButton({ label = 'Continue with Google', className = '' }: { label?: string; className?: string }) {
  return (
    <a href="/api/auth/google" className={`btn-dark h-12 px-6 text-base ${className}`}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
      {label}
    </a>
  );
}

const FEATURES: [string, string, string][] = [
  ['💸', 'Revenue by source', 'Connect Dodo Payments and see which tweet, article, Google page or AI chat brought paying customers.'],
  ['🔎', 'Every source, by name', 'X, Google, ChatGPT, Reddit, YouTube… plus tagged links per post, so you know exactly which one worked.'],
  ['🧭', 'Full visitor journeys', 'From first visit to payment: every page, every button click, and how long it took them to buy.'],
  ['🌍', 'Live globe', 'Watch visitors arrive on a 3D globe in real time, with a live feed of pages, clicks and payments.'],
  ['🎯', 'Goals & funnels', 'Track any button with one attribute and see where people drop off on the way to checkout.'],
  ['⚡️', '2-minute setup', 'One script tag, or copy the ready-made prompt and let your coding AI install it for you.'],
];

export function Landing() {
  const plan = usePlan();
  const error = new URLSearchParams(window.location.search).get('login_error');
  const spotsLeft = plan?.spotsLeft;

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <Logo />
        <nav className="flex items-center gap-1 text-sm sm:gap-4">
          <a href="#pricing" className="hidden rounded-lg px-3 py-2 text-stone-600 hover:text-ink sm:inline">
            Pricing
          </a>
          <a href={GITHUB_URL} className="hidden rounded-lg px-3 py-2 text-stone-600 hover:text-ink sm:inline">
            GitHub
          </a>
          <a href="/api/auth/google" className="btn">
            Sign in
          </a>
        </nav>
      </header>

      {error && <div className="mx-auto max-w-xl rounded-xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">{error}</div>}

      <section className="mx-auto max-w-4xl px-4 pb-10 pt-12 text-center sm:pt-20">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1 text-sm text-stone-600 shadow-card">
          <span className="h-2 w-2 rounded-full bg-revenue" /> Revenue-first analytics for indie makers
        </div>
        <h1 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
          Know which tweet made you <span className="text-revenue">money</span>.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-stone-600">
          Simple, accurate analytics that follows every visitor from the first click to the payment. Stop guessing which post, article or
          AI chat is actually growing your product.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <GoogleButton label={plan ? `Get started for ${priceLabel(plan)}` : 'Get started'} />
          {spotsLeft !== null && spotsLeft !== undefined && plan?.spots ? (
            <span className="text-sm text-stone-500">
              Founding price · <b className="text-ink">{spotsLeft}</b> of {plan.spots} spots left
            </span>
          ) : null}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <img src="/landing/dashboard.png" alt="Minilytics dashboard" className="w-full rounded-2xl border border-stone-200 shadow-xl" />
      </section>

      <section className="mx-auto mt-20 grid max-w-6xl gap-4 px-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(([icon, title, text]) => (
          <div key={title} className="card p-6">
            <div className="text-2xl">{icon}</div>
            <h3 className="mt-3 font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-stone-600">{text}</p>
          </div>
        ))}
      </section>

      <section id="pricing" className="mx-auto mt-20 max-w-md px-4">
        <h2 className="text-center text-3xl font-semibold tracking-tight">One simple plan</h2>
        <div className="card mt-8 p-8">
          <div className="text-sm font-medium uppercase tracking-wider text-revenue">Founding member</div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-5xl font-semibold">{plan?.price ?? '$9'}</span>
            <span className="text-stone-500">{plan?.interval === 'lifetime' ? 'one-time' : `/${plan?.interval ?? 'month'}`}</span>
          </div>
          <ul className="mt-6 space-y-2 text-sm">
            {[
              'Unlimited websites',
              'Unlimited events',
              'Revenue attribution with Dodo Payments',
              'Visitor journeys, goals & funnels',
              'Live globe',
              plan?.interval === 'lifetime' ? 'Pay once, use forever' : 'Cancel anytime',
            ].map((f) => (
              <li key={f} className="flex gap-2">
                <span className="text-emerald-600">✓</span> {f}
              </li>
            ))}
          </ul>
          <GoogleButton label="Get started" className="mt-8 w-full" />
          {spotsLeft !== null && spotsLeft !== undefined && plan?.spots ? (
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-stone-100">
                <div className="h-full bg-revenue" style={{ width: `${((plan.spots - spotsLeft) / plan.spots) * 100}%` }} />
              </div>
              <p className="mt-2 text-center text-xs text-stone-500">
                {spotsLeft} of {plan.spots} founding spots left at this price
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-2xl px-4">
        <h2 className="text-center text-2xl font-semibold">Questions</h2>
        <div className="mt-6 space-y-3">
          {[
            ['Is it really unlimited?', 'Yes: unlimited websites and events, within fair use for normal sites.'],
            ['What happens after the founding spots are gone?', 'The price goes up for new customers.'],
            ['Which payment providers are supported?', 'Dodo Payments works out of the box. Anything else can send payments through the simple payments API.'],
            ['Can I self-host it instead?', 'Yes. Minilytics is open source (MIT). Deploy it free on your own Cloudflare account from GitHub.'],
          ].map(([q, a]) => (
            <details key={q} className="card p-4">
              <summary className="cursor-pointer font-medium">{q}</summary>
              <p className="mt-2 text-sm text-stone-600">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="mx-auto mt-20 flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-stone-200 px-4 py-8 text-sm text-stone-500">
        <Logo small />
        <div className="flex flex-wrap gap-4">
          <a href="/terms" className="hover:text-ink">Terms</a>
          <a href="/privacy" className="hover:text-ink">Privacy</a>
          <a href="/refund" className="hover:text-ink">Refunds</a>
          <a href={GITHUB_URL} className="hover:text-ink">GitHub</a>
          {plan?.supportEmail && (
            <a href={`mailto:${plan.supportEmail}`} className="hover:text-ink">
              {plan.supportEmail}
            </a>
          )}
        </div>
      </footer>
    </div>
  );
}
