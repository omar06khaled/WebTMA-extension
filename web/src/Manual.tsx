import { useState } from 'react'
import { campusName, url, type Article, type ArticleRow, type SearchResult } from './api'
import { FlagButton, Link, ManualText, navigate, useGet } from './ui'

/** The manual's articles: contents by section, a search, and each article on its own page. */
export default function Manual({ path }: { path: string }) {
  const id = Number(path.split('/')[2])
  return id ? <ArticlePage id={id} /> : <Contents />
}

function Contents() {
  const [q, setQ] = useState('')
  const all = useGet<ArticleRow[]>('/api/manual')
  const found = useGet<SearchResult>(q.trim() ? url('/api/search', { q: q.trim() }) : null, 200)

  const sections = new Map<string, ArticleRow[]>()
  for (const a of all.data ?? []) {
    const k = a.category ?? 'Other'
    sections.set(k, [...(sections.get(k) ?? []), a])
  }

  return (
    <div className="page">
      <h1>Desk manual</h1>
      <input type="search" className="big-search" value={q} onChange={(e) => setQ(e.target.value)}
             placeholder="Search the manual" aria-label="Search the manual" autoComplete="off" />
      {all.error && <p className="error">{all.error}</p>}
      {q.trim() ? (
        <section className="box">
          <h3>Articles matching “{q.trim()}”</h3>
          {found.data?.articles.length === 0 && <p className="muted">No article mentions that.</p>}
          <ul className="link-list">
            {found.data?.articles.map((a) => (
              <li key={a.id}>
                <Link to={`/manual/${a.id}`}>{a.title} <small>{a.category}</small></Link>
                {a.snippet && <p className="snippet">{a.snippet}</p>}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="toc">
          {[...sections].map(([section, articles]) => (
            <section className="box" key={section}>
              <h3>{section}</h3>
              <ul className="link-list">
                {articles.map((a) => (
                  <li key={a.id}>
                    <Link to={`/manual/${a.id}`}>
                      {a.title} {a.campusCode && <small>{campusName(a.campusCode)}</small>}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function ArticlePage({ id }: { id: number }) {
  const { data: a, error } = useGet<Article>(`/api/manual/${id}`)
  return (
    <div className="page">
      <button type="button" className="text-button back" onClick={() => navigate('/manual')}>← Contents</button>
      {error && <p className="error">{error}</p>}
      {a && (
        <article>
          <div className="result-head">
            <div>
              <h1>{a.title}</h1>
              <p className="muted">{a.category}{a.campusCode && ` · ${campusName(a.campusCode)}`}</p>
            </div>
            <FlagButton target={{ table: 'article', key: String(a.id), label: a.title }} />
          </div>
          <div className="box"><ManualText text={a.bodyMd} /></div>
        </article>
      )}
    </div>
  )
}
