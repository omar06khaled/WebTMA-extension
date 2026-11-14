import type { ReactNode } from 'react'

// The Markdown the importer (db/import_articles.py) writes, and nothing more: "### " headings,
// "- " lists, tables (cells escape | as \| and line breaks as <br>), [links](url), **bold** and
// paragraphs whose lines keep their breaks. Builds React elements, never HTML strings.

const SEPARATOR = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/
const SAFE_LINK = /^(https?:|mailto:|tel:)/i

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
    } else if (line.startsWith('|') && SEPARATOR.test(lines[i + 1] ?? '')) {
      const header = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]))
      out.push(
        <div className="scroll md-table" key={out.length}>
          <table>
            <thead><tr>{header.map((h, k) => <th key={k}>{inline(h)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>{header.map((_, k) => <td key={k}>{inline(r[k] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
    } else if (/^#{1,6} /.test(line)) {
      out.push(<h3 key={out.length}>{inline(line.replace(/^#+ /, ''))}</h3>)
      i++
    } else if (line.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2))
      out.push(<ul key={out.length}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>)
    } else {
      const para: string[] = []
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('- ') && !/^#{1,6} /.test(lines[i])
             && !(lines[i].startsWith('|') && SEPARATOR.test(lines[i + 1] ?? ''))) {
        para.push(lines[i++].replace(/\s+$/, ''))
      }
      out.push(<p key={out.length}>{para.map((p, k) => <span key={k}>{k > 0 && <br />}{inline(p)}</span>)}</p>)
    }
  }
  return <div className="markdown">{out}</div>
}

/** "| a | b \| c |" -> ["a", "b | c"] */
function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Links, bold and <br> inside a line. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|<br\s*\/?>/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      parts.push(SAFE_LINK.test(m[2])
        ? <a key={parts.length} href={m[2]} target="_blank" rel="noreferrer noopener">{m[1]}</a>
        : `${m[1]} (${m[2]})`)
    } else if (m[3] !== undefined) {
      parts.push(<strong key={parts.length}>{m[3]}</strong>)
    } else {
      parts.push(<br key={parts.length} />)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
