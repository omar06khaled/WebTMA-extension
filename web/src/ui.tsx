import { useEffect, useState, type ReactNode } from 'react'
import { get, post, type Kind } from './api'
import { Markdown } from './markdown'

// ---------------------------------------------------------------- navigation
// A small router: the URL is the state, so any screen can be bookmarked or shared.

export function navigate(to: string) {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }))
  useEffect(() => {
    const on = () => setLoc({ path: window.location.pathname, search: window.location.search })
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return loc
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}

// ---------------------------------------------------------------- data

/** Fetches `path` whenever it changes (null = nothing to fetch). Typing fast only shows the last answer. */
export function useGet<T>(path: string | null, delayMs = 0) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>(
    { data: null, error: null, loading: false })
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      get<T>(path)
        .then((data) => live && setState({ data, error: null, loading: false }))
        .catch((e) => live && setState({ data: null, error: e.message, loading: false }))
    }, delayMs)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [path, delayMs])
  return state
}

// ---------------------------------------------------------------- small pieces

export const KIND_LABEL: Record<Kind, string> = {
  zone: 'Zone', trade: 'Trade', see_note: 'See notes', not_handled: 'Not handled',
}

export function KindBadge({ kind }: { kind: Kind }) {
  return <span className={`kind kind-${kind}`}>{KIND_LABEL[kind]}</span>
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="copy"
      aria-label={`${label} ${text}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard blocked: nothing to do, the text is on screen */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

/** Text from the manual (notes and articles): tables, lists, headings and links, keeping line breaks. */
export function ManualText({ text }: { text: string }) {
  return <Markdown text={text} />
}

// ---------------------------------------------------------------- flag a mistake

export type FlagTarget = { table: string; key: string; label: string }

export function FlagButton({ target }: { target: FlagTarget }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="button secondary small" onClick={() => setOpen(true)}>
        Flag a mistake
      </button>
      {open && <FlagDialog target={target} onClose={() => setOpen(false)} />}
    </>
  )
}

function FlagDialog({ target, onClose }: { target: FlagTarget; onClose: () => void }) {
  const [wo, setWo] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="flag-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="flag-title">Flag a mistake</h2>
        <p className="muted">{target.label}</p>
        {sent ? (
          <>
            <p>Thanks. Flag #{sent} is with the editors.</p>
            <button className="button" onClick={onClose} autoFocus>Close</button>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setError('')
              try {
                const r = await post<{ id: number }>('/api/flags', {
                  woNumber: wo, description, targetTable: target.table, targetKey: target.key,
                })
                setSent(r.id)
              } catch (err) {
                setError((err as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {error && <p className="error">{error}</p>}
            <label>
              WO number
              <input value={wo} onChange={(e) => setWo(e.target.value)} required autoFocus inputMode="numeric" maxLength={40} />
            </label>
            <label>
              What's wrong?
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} required rows={4} maxLength={4000} />
            </label>
            <div className="actions">
              <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="button" disabled={busy}>{busy ? 'Sending…' : 'Send flag'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
