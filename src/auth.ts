const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string

export interface AuthState {
  token: string
  username: string
  avatarUrl: string
}

const AUTH_KEY = 'pomelo:auth'

export function loadAuth(): AuthState | null {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null') }
  catch { return null }
}

export function saveAuth(auth: AuthState) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth))
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY)
}

export async function startDeviceFlow() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'gist' }),
  })
  const data = await res.json()
  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    interval: (data.interval as number) ?? 5,
  }
}

export async function pollForToken(deviceCode: string, interval: number): Promise<string | null> {
  await new Promise(r => setTimeout(r, interval * 1000))
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  const data = await res.json()
  if (data.access_token) return data.access_token as string
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return null
  throw new Error(data.error_description || data.error || 'Auth failed')
}

export async function fetchUser(token: string): Promise<{ username: string; avatarUrl: string }> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  return { username: data.login as string, avatarUrl: data.avatar_url as string }
}
