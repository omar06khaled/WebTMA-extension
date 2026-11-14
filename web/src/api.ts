// Every call to the C# API goes through here. Writes carry X-Desk-Manual, which the API
// requires on anything that isn't a GET (it blocks cross-site request forgery).

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'X-Desk-Manual': '1' }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data)
  return data as T
}

export const get = <T>(path: string) => call<T>('GET', path)
export const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body)

/** Builds "/path?a=1&b=2", leaving out empty values. */
export function url(path: string, params: Record<string, string | number | null | undefined>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

export type Me = { asurite: string; name: string; role: string }
export type Health = { status: string; liveVersion: number | null }

export type Campus = 'dtpc' | 'poly' | 'tempe' | 'west'
export const CAMPUSES: Record<Campus, string> = { dtpc: 'Downtown', poly: 'Polytechnic', tempe: 'Tempe', west: 'West' }
export const campusName = (c: string | null | undefined) => (c ? CAMPUSES[c as Campus] ?? c : 'No campus on file')

export type Kind = 'zone' | 'trade' | 'see_note' | 'not_handled'

export type TaskRow = { id: number; taskCode: number | null; description: string; category: string }
export type BuildingRow = { code: string; name: string; campusCode: string | null }
export type ZoneRow = { code: string; campusCode: string | null; isRfmt: boolean; notes: string | null }
export type TradeRow = { code: string; isGlobal: boolean; notes: string | null }

export type BuildingDetail = BuildingRow & {
  subtype: string | null
  rateSchedule: string | null
  managedBy: string | null
  regularZones: string[] | null
  rfmtZones: string[] | null
  notes: string[]
}

export type Cell = {
  campusCode: Campus
  isRfmt: boolean
  kind: Kind
  tradeCode: string | null
  instruction: string | null
  zoneOptions: string[] | null
}

export type Answer = {
  campus: Campus
  isRfmt: boolean
  kind: Kind
  trade: string | null
  instruction: string | null
  zoneOptions: string[] | null
  zones: string[] | null
}

export type RouteAnswer = {
  task: TaskRow & { notes: string | null; sectionNote: string | null; custodial: boolean }
  building: BuildingDetail | null
  campus: Campus | null
  answers: Answer[]
  grid: Cell[]
  generalNote: string | null
}

export type ArticleRow = { id: number; title: string; category: string | null; campusCode: string | null }
export type Article = ArticleRow & { bodyMd: string }

export type SearchResult = {
  tasks: TaskRow[]
  buildings: BuildingRow[]
  zones: ZoneRow[]
  trades: TradeRow[]
  articles: (ArticleRow & { snippet: string })[]
}

export type ZoneDetail = { zone: ZoneRow; buildings: BuildingRow[] }
export type TradeDetail = {
  trade: TradeRow
  tasks: { taskId: number; taskCode: number | null; description: string; category: string; campusCode: Campus; isRfmt: boolean }[]
}
