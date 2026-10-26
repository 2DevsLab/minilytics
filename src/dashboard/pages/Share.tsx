import { useEffect, useState } from 'react';
import { DEFAULT_SHARE_PERIOD, SHARE_PERIODS, type PublicRow, type PublicShare, type SharePeriod } from '../../shared/publicStats';

function List({ title, rows }: { title: string; rows: PublicRow[] }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-stone-500">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">No data</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {rows.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-3">
              <span className="truncate">{row.label}</span>
              <span className="shrink-0 text-stone-500">
                {row.visitors} <span className="text-stone-400">/ {row.pageviews}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SharePage({ siteId }: { siteId: string }) {
  const [period, setPeriod] = useState<SharePeriod>(DEFAULT_SHARE_PERIOD);
  const [data, setData] = useState<PublicShare | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancel = false;
    setUnavailable(false);
    fetch(`/api/public/${siteId}/share?period=${period}`, { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) throw new Error('unavailable');
        return (await res.json()) as PublicShare;
      })
      .then((body) => {
        if (!cancel) setData(body);
      })
      .catch(() => {
        if (!cancel) {
          setData(null);
          setUnavailable(true);
        }
      });
    return () => {
      cancel = true;
    };
  }, [siteId, period]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Stats</h1>
        <div className="flex gap-2">
          {SHARE_PERIODS.map((item) => (
            <button key={item} className={item === period ? 'btn-dark' : 'btn'} onClick={() => setPeriod(item)}>
              {item}
            </button>
          ))}
        </div>
      </div>
      {unavailable && <p className="mt-8 text-stone-500">These stats aren't available.</p>}
      {data && (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="card p-5">
              <div className="text-sm text-stone-500">Visitors</div>
              <div className="text-3xl font-semibold">{data.visitors}</div>
            </div>
            <div className="card p-5">
              <div className="text-sm text-stone-500">Pageviews</div>
              <div className="text-3xl font-semibold">{data.pageviews}</div>
            </div>
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <List title="Pages" rows={data.pages} />
            <List title="Referrers" rows={data.referrers} />
            <List title="Countries" rows={data.countries} />
          </div>
        </>
      )}
    </div>
  );
}
