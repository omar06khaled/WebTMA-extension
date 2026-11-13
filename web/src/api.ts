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

export type Me = { asurite: string; name: string; role: string }
export type Health = { status: string; liveVersion: number | null }
