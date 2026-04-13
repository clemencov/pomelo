import type { Task, LogEntry } from './types'

const GIST_ID_KEY = 'pomelo:gist_id'
const FILENAME = 'pomelo-data.json'

export interface GistData {
  tasks: Task[]
  log: LogEntry[]
}

export function loadGistId(): string | null {
  return localStorage.getItem(GIST_ID_KEY)
}

export function saveGistId(id: string) {
  localStorage.setItem(GIST_ID_KEY, id)
}

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
})

export async function loadFromGist(token: string, gistId: string): Promise<GistData | null> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: headers(token) })
  if (!res.ok) return null
  const gist = await res.json()
  const content = gist.files?.[FILENAME]?.content
  if (!content) return null
  return JSON.parse(content) as GistData
}

// Find existing pomelo gist by scanning user's gists
export async function findPomeloGist(token: string): Promise<string | null> {
  const res = await fetch('https://api.github.com/gists?per_page=100', { headers: headers(token) })
  if (!res.ok) return null
  const gists = await res.json() as Array<{ id: string; files: Record<string, unknown> }>
  const found = gists.find(g => FILENAME in g.files)
  return found?.id ?? null
}

export async function saveToGist(token: string, gistId: string | null, data: GistData): Promise<string> {
  const body = JSON.stringify({
    description: 'pomelo — recurring task data',
    public: false,
    files: { [FILENAME]: { content: JSON.stringify(data, null, 2) } },
  })

  if (gistId) {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH', headers: headers(token), body,
    })
    return ((await res.json()) as { id: string }).id
  } else {
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST', headers: headers(token), body,
    })
    const gist = (await res.json()) as { id: string }
    saveGistId(gist.id)
    return gist.id
  }
}
