import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, get, post, type Health, type Me } from './api'
import Dispatch from './Dispatch'
import Lookups from './Lookups'
import Manual from './Manual'
import { Link, useLocation } from './ui'

type Session =
  | { state: 'loading' }
  | { state: 'signedOut'; signIn: 'cas' | 'dev' }
  | { state: 'signedIn'; me: Me }
  | { state: 'error'; message: string }

const NAV = [
  { to: '/', label: 'Dispatch', match: (p: string) => p === '/' },
  { to: '/lookups', label: 'Lookups', match: (p: string) => p.startsWith('/lookups') },
  { to: '/manual', label: 'Manual', match: (p: string) => p.startsWith('/manual') },
]

export default function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })
  const { path, search } = useLocation()

  const load = () =>
    get<Me>('/auth/me')
      .then((me) => setSession({ state: 'signedIn', me }))
      .catch((e) => {
        const signIn = (e instanceof ApiError && (e.body as { signIn?: 'cas' | 'dev' })?.signIn) || null
        setSession(signIn ? { state: 'signedOut', signIn } : { state: 'error', message: e.message })
      })

  useEffect(() => {
    load()
  }, [])

  const signOut = async () => {
    const { redirect } = await post<{ redirect: string }>('/auth/logout')
    window.location.assign(redirect)
  }

  const signedIn = session.state === 'signedIn'

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <Link to="/" className="brand">Desk Manual</Link>
          {signedIn && (
            <nav aria-label="Main">
              {NAV.map((n) => (
                <Link key={n.to} to={n.to} className={n.match(path) ? 'active' : ''}>{n.label}</Link>
              ))}
            </nav>
          )}
          {signedIn && (
            <span className="who">
              <span className="who-name">{session.me.name}</span>
              <span className="role">{session.me.role}</span>
              <button className="link" onClick={signOut}>Sign out</button>
            </span>
          )}
        </div>
      </header>
      <main>
        {session.state === 'loading' && <p className="muted">Loading…</p>}
        {session.state === 'error' && <p className="error">{session.message}</p>}
        {session.state === 'signedOut' && <SignIn mode={session.signIn} onSignedIn={load} />}
        {signedIn && (
          path.startsWith('/lookups') ? <Lookups path={path} search={search} />
            : path.startsWith('/manual') ? <Manual path={path} />
              : <Dispatch search={path === '/' ? search : ''} />
        )}
      </main>
      {signedIn && <Footer />}
    </>
  )
}

function Footer() {
  const [health, setHealth] = useState<Health | null>(null)
  useEffect(() => {
    get<Health>('/api/health').then(setHealth).catch(() => setHealth(null))
  }, [])
  return (
    <footer className="footer">
      {health?.liveVersion ? `Live manual version ${health.liveVersion}` : 'Live manual version unknown'}
      {' · '}Answers come from the published manual only.
    </footer>
  )
}

function SignIn({ mode, onSignedIn }: { mode: 'cas' | 'dev'; onSignedIn: () => void }) {
  const params = new URLSearchParams(window.location.search)
  const [asurite, setAsurite] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState(
    params.has('noaccess') ? 'Your ASURITE has no access. Ask a desk manager.'
      : params.has('failed') ? 'ASU sign-in did not complete. Try again.'
        : '',
  )

  if (mode === 'cas') {
    return (
      <section className="card narrow">
        <h1>Sign in</h1>
        {error && <p className="error">{error}</p>}
        <a className="button" href="/auth/login">Sign in with your ASURITE</a>
      </section>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await post('/auth/dev-login', { asurite, name })
      if (window.location.pathname === '/signin') window.history.replaceState(null, '', '/')
      onSignedIn()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section className="card narrow">
      <h1>Sign in (development)</h1>
      <p className="muted">Stand-in for ASU CAS. It only exists on a developer's machine.</p>
      {error && <p className="error">{error}</p>}
      <form onSubmit={submit}>
        <label>
          ASURITE
          <input value={asurite} onChange={(e) => setAsurite(e.target.value)} autoFocus required />
        </label>
        <label>
          Display name <span className="muted">(optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="button" type="submit">Sign in</button>
      </form>
    </section>
  )
}
