import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, get, post, type Health, type Me } from './api'

type Session =
  | { state: 'loading' }
  | { state: 'signedOut'; signIn: 'cas' | 'dev' }
  | { state: 'signedIn'; me: Me }
  | { state: 'error'; message: string }

export default function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })

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

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <span className="brand">Desk Manual</span>
          {session.state === 'signedIn' && (
            <span className="who">
              {session.me.name} <span className="role">{session.me.role}</span>
              <button className="link" onClick={signOut}>Sign out</button>
            </span>
          )}
        </div>
      </header>
      <main>
        {session.state === 'loading' && <p className="muted">Loading…</p>}
        {session.state === 'error' && <p className="error">{session.message}</p>}
        {session.state === 'signedOut' && <SignIn mode={session.signIn} onSignedIn={load} />}
        {session.state === 'signedIn' && <Home me={session.me} />}
      </main>
    </>
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
      window.history.replaceState(null, '', '/')
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

function Home({ me }: { me: Me }) {
  const [health, setHealth] = useState<Health | string | null>(null)

  useEffect(() => {
    get<Health>('/api/health').then(setHealth).catch((e) => setHealth(e.message))
  }, [])

  return (
    <section className="card">
      <h1>Signed in as {me.asurite}</h1>
      <dl>
        <dt>Name</dt>
        <dd>{me.name}</dd>
        <dt>Role</dt>
        <dd>{me.role}</dd>
        <dt>Live manual</dt>
        <dd>
          {health === null ? 'Checking…'
            : typeof health === 'string' ? <span className="error">{health}</span>
              : health.liveVersion === null ? 'Nothing published yet'
                : `Version ${health.liveVersion}`}
        </dd>
      </dl>
      <p className="muted">Dispatch and Lookups come next.</p>
    </section>
  )
}
