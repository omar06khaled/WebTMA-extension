import { useState, type ReactNode } from 'react'
import {
  CAMPUSES, campusName, url,
  type Answer, type BuildingRow, type Campus, type RouteAnswer, type TaskRow,
} from './api'
import { CopyButton, FlagButton, KindBadge, Link, ManualText, navigate, useGet } from './ui'

/** Dispatch: pick a task and a building (or campus) and see who gets the call, and why. */
export default function Dispatch({ search }: { search: string }) {
  const params = new URLSearchParams(search)
  const taskId = params.get('task')
  const building = params.get('building')
  const campus = params.get('campus') as Campus | null

  const set = (changes: Record<string, string | null>) => {
    const next = { task: taskId, building, campus, ...changes }
    navigate(url('/', next))
  }

  const route = useGet<RouteAnswer>(taskId ? url('/api/dispatch/route', { taskId, building, campus }) : null)
  const r = route.data

  return (
    <div className="dispatch">
      <aside className="panel">
        <Picker<TaskRow>
          label="1. Task"
          placeholder="lock, hot call, 27070, plumbing…"
          endpoint="/api/tasks"
          chosen={r && taskId ? `${r.task.description} · ${r.task.category}` : taskId ? 'Loading…' : null}
          onClear={() => set({ task: null })}
          render={(t) => (
            <>
              {t.description}
              <small>{t.taskCode ?? 'no code'} · {t.category}</small>
            </>
          )}
          onPick={(t) => set({ task: String(t.id) })}
        />
        <Picker<BuildingRow>
          label="2. Building (optional)"
          placeholder="157A, Hayden, Memorial Union…"
          endpoint="/api/buildings"
          chosen={building ? (r?.building ? `${r.building.code} · ${r.building.name}` : building) : null}
          onClear={() => set({ building: null })}
          render={(b) => (
            <>
              {b.name}
              <small>{b.code} · {campusName(b.campusCode)}</small>
            </>
          )}
          onPick={(b) => set({ building: b.code })}
        />
        <div>
          <span className="field-label">Or campus</span>
          <div className="chips" role="group" aria-label="Campus">
            {(Object.keys(CAMPUSES) as Campus[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={(r?.campus ?? campus) === c}
                disabled={!!r?.building?.campusCode}
                onClick={() => set({ campus: campus === c ? null : c })}
              >
                {CAMPUSES[c]}
              </button>
            ))}
          </div>
          <p className="hint">A building sets the campus. With neither, all four campuses show.</p>
        </div>
      </aside>

      <section className="result" aria-live="polite">
        {!taskId && <div className="empty">Pick a task to see who gets the call.</div>}
        {route.error && <div className="empty error">{route.error}</div>}
        {r && <Result r={r} />}
      </section>
    </div>
  )
}

function Result({ r }: { r: RouteAnswer }) {
  const t = r.task
  const b = r.building
  const where = b ? `${b.name} (${b.code}) · ${campusName(b.campusCode)}` : r.campus ? campusName(r.campus) : 'All campuses'
  const byCampus = Object.keys(CAMPUSES).filter((c) => r.answers.some((a) => a.campus === c)) as Campus[]

  return (
    <>
      <div className="result-head">
        <div>
          <h1>{t.description}</h1>
          <p className="muted">
            <code>{t.taskCode ?? 'no code'}</code> · {t.category}
            {t.custodial && ' · custodial'} · {where}
          </p>
        </div>
        <FlagButton target={{
          table: 'task', key: String(t.id),
          label: `${t.description}${b ? ` at ${b.code}` : ''}`,
        }} />
      </div>

      {b && !b.campusCode && (
        <div className="callout warn">This building has no campus on file, so every campus is shown.</div>
      )}

      <div className="answers">
        {byCampus.map((c) => (
          <div className="answer" key={c}>
            <h2>{CAMPUSES[c]}</h2>
            {r.answers.filter((a) => a.campus === c).map((a) => (
              <AnswerRow key={String(a.isRfmt)} a={a} hasBuilding={!!b} />
            ))}
          </div>
        ))}
      </div>

      {b && b.notes.length > 0 && <Note title="Building notes" text={b.notes.join('\n\n')} />}
      {t.sectionNote && <Note title={`${t.category} section note`} text={t.sectionNote} />}
      {t.notes && <Note title="Task notes" text={t.notes} />}
      {r.generalNote && <Note title={`General notes after ${t.category}`} text={r.generalNote} plain />}

      <details className="box">
        <summary>All eight cells for this task</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Campus</th><th>WO</th><th>Kind</th><th>Trade</th><th>Zones on campus</th></tr>
            </thead>
            <tbody>
              {r.grid.map((g) => (
                <tr key={g.campusCode + g.isRfmt} className={g.campusCode === r.campus ? 'here' : ''}>
                  <td>{CAMPUSES[g.campusCode]}</td>
                  <td>{g.isRfmt ? 'RFMT' : 'Regular'}</td>
                  <td><KindBadge kind={g.kind} /></td>
                  <td>{g.tradeCode && <Link to={`/lookups/trade/${encodeURIComponent(g.tradeCode)}`}>{g.tradeCode}</Link>}</td>
                  <td>{(g.zoneOptions ?? []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}

function AnswerRow({ a, hasBuilding }: { a: Answer; hasBuilding: boolean }) {
  let to: string | null = null
  let text: string
  if (a.kind === 'trade') text = to = a.trade!
  else if (a.kind === 'zone') {
    if (a.zones?.length) text = to = a.zones.join(' / ')
    else text = hasBuilding ? 'No zone on file' : "The building's zone"
  } else if (a.kind === 'see_note') text = 'See the notes below'
  else text = 'Not handled on this campus'

  return (
    <div className={`answer-row kind-row-${a.kind}`}>
      <span className="wo">{a.isRfmt ? 'RFMT WO' : 'Regular WO'}</span>
      <span className="send-to">
        <strong className={to ? 'code' : ''}>{text}</strong>
        {to && <CopyButton text={to} />}
      </span>
      <KindBadge kind={a.kind} />
      {a.instruction && <p className="small">{a.instruction}</p>}
      {a.kind === 'zone' && !a.zones?.length && a.zoneOptions && (
        <p className="small">Zones on this campus: {a.zoneOptions.join(', ')}</p>
      )}
    </div>
  )
}

function Note({ title, text, plain }: { title: string; text: string; plain?: boolean }) {
  return (
    <div className={`box ${plain ? '' : 'note'}`}>
      <h3>{title}</h3>
      <ManualText text={text} />
    </div>
  )
}

/** A search box with a result list; once something is picked it shows as a chip with Clear. */
function Picker<T>({ label, placeholder, endpoint, chosen, onClear, render, onPick }: {
  label: string
  placeholder: string
  endpoint: string
  chosen: string | null
  onClear: () => void
  render: (row: T) => ReactNode
  onPick: (row: T) => void
}) {
  const [q, setQ] = useState('')
  const id = label.replace(/\W+/g, '-').toLowerCase()
  const results = useGet<T[]>(q.trim() ? url(endpoint, { q: q.trim() }) : null, 180)

  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      {chosen ? (
        <div className="chosen">
          <span>{chosen}</span>
          <button type="button" className="text-button" onClick={onClear}>Clear</button>
        </div>
      ) : (
        <>
          <input id={id} type="search" value={q} placeholder={placeholder} autoComplete="off"
                 onChange={(e) => setQ(e.target.value)} />
          {q.trim() && results.data && (
            <ul className="pick-list">
              {results.data.length === 0 && <li className="none">No match</li>}
              {results.data.map((row, i) => (
                <li key={i}>
                  <button type="button" onClick={() => { setQ(''); onPick(row) }}>{render(row)}</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
