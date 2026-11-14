import { useState, type ReactNode } from 'react'
import {
  CAMPUSES, campusName, url,
  type BuildingDetail, type SearchResult, type TradeDetail, type ZoneDetail,
} from './api'
import { CopyButton, FlagButton, Link, ManualText, navigate, useGet } from './ui'

/** Lookups: one search box for buildings, zones, trades, tasks and articles, then a page for each. */
export default function Lookups({ path, search }: { path: string; search: string }) {
  const [, , kind, rawCode] = path.split('/') // "", "lookups", kind, code
  const code = rawCode ? decodeURIComponent(rawCode) : null
  if (kind === 'building' && code) return <BuildingPage code={code} />
  if (kind === 'zone' && code) return <ZonePage code={code} />
  if (kind === 'trade' && code) return <TradePage code={code} />
  return <SearchPage initial={new URLSearchParams(search).get('q') ?? ''} />
}

function SearchPage({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial)
  const res = useGet<SearchResult>(q.trim() ? url('/api/search', { q: q.trim() }) : null, 200)
  const d = res.data
  const nothing = d && !d.tasks.length && !d.buildings.length && !d.zones.length && !d.trades.length && !d.articles.length

  return (
    <div className="page">
      <h1>Lookups</h1>
      <input
        type="search" className="big-search" value={q} autoFocus autoComplete="off"
        placeholder="Building, zone, trade, task or anything in the manual"
        aria-label="Search the desk manual"
        onChange={(e) => {
          setQ(e.target.value)
          window.history.replaceState(null, '', url('/lookups', { q: e.target.value }))
        }}
      />
      {res.error && <p className="error">{res.error}</p>}
      {nothing && <p className="muted">Nothing matches “{q}”.</p>}
      {d && (
        <div className="search-results">
          {d.buildings.length > 0 && (
            <Group title="Buildings">
              {d.buildings.map((b) => (
                <li key={b.code}>
                  <Link to={`/lookups/building/${encodeURIComponent(b.code)}`}>
                    {b.name} <small>{b.code} · {campusName(b.campusCode)}</small>
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {d.zones.length > 0 && (
            <Group title="Zones">
              {d.zones.map((z) => (
                <li key={z.code}>
                  <Link to={`/lookups/zone/${encodeURIComponent(z.code)}`}>
                    {z.code} <small>{campusName(z.campusCode)}{z.isRfmt && ' · RFMT'}</small>
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {d.trades.length > 0 && (
            <Group title="Trades">
              {d.trades.map((t) => (
                <li key={t.code}>
                  <Link to={`/lookups/trade/${encodeURIComponent(t.code)}`}>
                    {t.code} {t.isGlobal && <small>all campuses</small>}
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {d.tasks.length > 0 && (
            <Group title="Tasks">
              {d.tasks.map((t) => (
                <li key={t.id}>
                  <Link to={url('/', { task: t.id })}>
                    {t.description} <small>{t.taskCode ?? 'no code'} · {t.category}</small>
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {d.articles.length > 0 && (
            <Group title="Manual">
              {d.articles.map((a) => (
                <li key={a.id}>
                  <Link to={`/manual/${a.id}`}>
                    {a.title} <small>{a.category}</small>
                  </Link>
                  {a.snippet && <p className="snippet">{a.snippet}</p>}
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="box">
      <h3>{title}</h3>
      <ul className="link-list">{children}</ul>
    </section>
  )
}

function Back() {
  return (
    <button type="button" className="text-button back" onClick={() => window.history.length > 1 ? window.history.back() : navigate('/lookups')}>
      ← Back
    </button>
  )
}

function BuildingPage({ code }: { code: string }) {
  const { data: b, error } = useGet<BuildingDetail>(`/api/buildings/${encodeURIComponent(code)}`)
  if (error) return <div className="page"><Back /><p className="error">{error}</p></div>
  if (!b) return <div className="page"><p className="muted">Loading…</p></div>
  const zones = [...(b.regularZones ?? []).map((z) => [z, 'Regular WO']), ...(b.rfmtZones ?? []).map((z) => [z, 'RFMT WO'])]

  return (
    <div className="page">
      <Back />
      <div className="result-head">
        <div>
          <h1>{b.name}</h1>
          <p className="muted">
            <code>{b.code}</code> <CopyButton text={b.code} /> · {campusName(b.campusCode)}
            {b.subtype && ` · ${b.subtype}`}
          </p>
        </div>
        <FlagButton target={{ table: 'building', key: b.code, label: `${b.code} · ${b.name}` }} />
      </div>
      <div className="box">
        <h3>Zones</h3>
        {zones.length === 0 ? <p className="muted">No zone on file.</p> : (
          <ul className="link-list">
            {zones.map(([z, wo]) => (
              <li key={z}>
                <Link to={`/lookups/zone/${encodeURIComponent(z)}`}><strong className="code">{z}</strong></Link>
                <small> {wo}</small> <CopyButton text={z} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="facts box">
        <dt>Rate schedule</dt><dd>{b.rateSchedule ?? '—'}</dd>
        <dt>Managed by</dt><dd>{b.managedBy ?? '—'}</dd>
      </dl>
      {b.notes.length > 0 && <div className="box note"><h3>Building notes</h3><ManualText text={b.notes.join('\n\n')} /></div>}
      <p><Link className="button" to={url('/', { building: b.code })}>Dispatch a task here</Link></p>
    </div>
  )
}

function ZonePage({ code }: { code: string }) {
  const [filter, setFilter] = useState('')
  const { data, error } = useGet<ZoneDetail>(`/api/zones/${encodeURIComponent(code)}`)
  if (error) return <div className="page"><Back /><p className="error">{error}</p></div>
  if (!data) return <div className="page"><p className="muted">Loading…</p></div>
  const f = filter.trim().toLowerCase()
  const shown = data.buildings.filter((b) => !f || b.code.toLowerCase().includes(f) || b.name.toLowerCase().includes(f))

  return (
    <div className="page">
      <Back />
      <div className="result-head">
        <div>
          <h1><span className="code">{data.zone.code}</span> <CopyButton text={data.zone.code} /></h1>
          <p className="muted">{campusName(data.zone.campusCode)}{data.zone.isRfmt ? ' · RFMT zone' : ' · Regular zone'}</p>
        </div>
        <FlagButton target={{ table: 'zone', key: data.zone.code, label: `Zone ${data.zone.code}` }} />
      </div>
      {data.zone.notes && <div className="box note"><h3>Zone notes</h3><ManualText text={data.zone.notes} /></div>}
      <div className="callout">Who's on call for this zone comes with the contacts, in the next phase.</div>
      <div className="box">
        <h3>{data.buildings.length} buildings</h3>
        <input type="search" placeholder="Filter buildings" value={filter} onChange={(e) => setFilter(e.target.value)}
               aria-label="Filter buildings in this zone" />
        <ul className="link-list columns">
          {shown.map((b) => (
            <li key={b.code}>
              <Link to={`/lookups/building/${encodeURIComponent(b.code)}`}>{b.code} <small>{b.name}</small></Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function TradePage({ code }: { code: string }) {
  const { data, error } = useGet<TradeDetail>(`/api/trades/${encodeURIComponent(code)}`)
  if (error) return <div className="page"><Back /><p className="error">{error}</p></div>
  if (!data) return <div className="page"><p className="muted">Loading…</p></div>

  // One row per task, with the campuses and WO types that send it to this trade.
  const rows = new Map<number, { t: TradeDetail['tasks'][number]; where: string[] }>()
  for (const t of data.tasks) {
    const row = rows.get(t.taskId) ?? { t, where: [] }
    row.where.push(`${CAMPUSES[t.campusCode]}${t.isRfmt ? ' RFMT' : ''}`)
    rows.set(t.taskId, row)
  }

  return (
    <div className="page">
      <Back />
      <div className="result-head">
        <div>
          <h1><span className="code">{data.trade.code}</span> <CopyButton text={data.trade.code} /></h1>
          <p className="muted">{data.trade.isGlobal ? 'Serves every campus' : 'Trade'}</p>
        </div>
        <FlagButton target={{ table: 'trade', key: data.trade.code, label: `Trade ${data.trade.code}` }} />
      </div>
      {data.trade.notes && <div className="box note"><h3>Trade notes</h3><ManualText text={data.trade.notes} /></div>}
      <div className="callout">Who's covering this trade comes with the contacts, in the next phase.</div>
      <div className="box">
        <h3>{rows.size} tasks go here</h3>
        <div className="scroll">
          <table>
            <thead><tr><th>Task</th><th>Category</th><th>Where</th></tr></thead>
            <tbody>
              {[...rows.values()].map(({ t, where }) => (
                <tr key={t.taskId}>
                  <td><Link to={url('/', { task: t.taskId })}>{t.description}</Link> <small className="muted">{t.taskCode}</small></td>
                  <td>{t.category}</td>
                  <td>{where.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
