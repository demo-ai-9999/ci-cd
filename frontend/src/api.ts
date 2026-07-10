export type User = {
  id: number
  username: string
}

export type LoginResponse = {
  access_token: string
  token_type: string
  user: User
}

export type ChatSessionSummary = {
  id: number
  title: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

export type ChatMessage = {
  id: number
  role: 'user' | 'assistant' | 'system' | string
  content: string
  model: string | null
  created_at: string
}

export type ChatSessionDetail = ChatSessionSummary & {
  messages: ChatMessage[]
}

export type ChatReplyResponse = {
  session_id: number
  answer: string
  user_message_id: number
  assistant_message_id: number
}

export type SearchResult = {
  title: string
  link: string
  snippet: string
}

export type SearchResponse = {
  query: string
  answer: string
  results: SearchResult[]
}

export type ApiValidationError = {
  detail?: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly payload: unknown

  constructor(status: number, message: string, payload: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  'https://ci-cd-backend-85367638612.asia-northeast3.run.app'
export const AUTH_TOKEN_KEY = 'myproject.auth.token'
export const AUTH_USER_KEY = 'myproject.auth.user'
export const LAST_CHAT_SESSION_KEY = 'myproject.chat.lastSessionId'
export const LOCAL_CHAT_MESSAGES_KEY = 'myproject.chat.localMessages'

function readErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload
  }

  if (payload && typeof payload === 'object') {
    const detail = (payload as ApiValidationError).detail
    if (typeof detail === 'string' && detail.trim()) {
      return detail
    }

    if (Array.isArray(detail) && detail.length > 0) {
      return detail
        .map((item) => {
          if (item && typeof item === 'object' && 'msg' in item) {
            return String((item as { msg?: unknown }).msg ?? '')
          }
          return ''
        })
        .filter(Boolean)
        .join(', ')
    }
  }

  return fallback
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return (await response.json()) as T
  }

  return (await response.text()) as T
}

export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  token: string | null = null,
): Promise<T> {
  const headers = new Headers(options.headers ?? {})

  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await parseResponse<unknown>(response)
    } catch {
      payload = null
    }

    throw new ApiError(
      response.status,
      readErrorMessage(payload, `HTTP ${response.status}`),
      payload,
    )
  }

  return parseResponse<T>(response)
}

export async function requestFormData<T>(
  path: string,
  formData: FormData,
  token: string | null = null,
): Promise<T> {
  const headers = new Headers()

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    body: formData,
    headers,
  })

  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await parseResponse<unknown>(response)
    } catch {
      payload = null
    }

    throw new ApiError(
      response.status,
      readErrorMessage(payload, `HTTP ${response.status}`),
      payload,
    )
  }

  return parseResponse<T>(response)
}

export function loadStoredToken() {
  return window.localStorage.getItem(AUTH_TOKEN_KEY)
}

export function storeAuth(token: string, user: User) {
  window.localStorage.setItem(AUTH_TOKEN_KEY, token)
  window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
}

export function clearAuthStorage() {
  window.localStorage.removeItem(AUTH_TOKEN_KEY)
  window.localStorage.removeItem(AUTH_USER_KEY)
  window.localStorage.removeItem(LAST_CHAT_SESSION_KEY)
  window.localStorage.removeItem(LOCAL_CHAT_MESSAGES_KEY)
}

export function loadStoredUser() {
  const raw = window.localStorage.getItem(AUTH_USER_KEY)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

export function loadLastChatSessionId() {
  const raw = window.localStorage.getItem(LAST_CHAT_SESSION_KEY)
  if (!raw) {
    return null
  }

  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function storeLastChatSessionId(sessionId: number | null) {
  if (sessionId === null) {
    window.localStorage.removeItem(LAST_CHAT_SESSION_KEY)
    return
  }

  window.localStorage.setItem(LAST_CHAT_SESSION_KEY, String(sessionId))
}

export function loadLocalChatMessages() {
  const raw = window.localStorage.getItem(LOCAL_CHAT_MESSAGES_KEY)
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, ChatMessage[]>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function storeLocalChatMessages(messagesBySessionId: Record<number, ChatMessage[]>) {
  window.localStorage.setItem(LOCAL_CHAT_MESSAGES_KEY, JSON.stringify(messagesBySessionId))
}

export async function login(username: string, password: string) {
  return requestJson<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function logout(token: string | null) {
  return requestJson<void>(
    '/auth/logout',
    {
      method: 'POST',
    },
    token,
  )
}

export async function getCurrentUser(token: string) {
  return requestJson<User>('/auth/me', { method: 'GET' }, token)
}

export async function signUp(username: string, password: string) {
  return requestJson<User>('/users', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function listChatSessions(token: string) {
  return requestJson<ChatSessionSummary[]>('/chat/sessions', { method: 'GET' }, token)
}

export async function createChatSession(
  token: string,
  title: string | null = null,
) {
  return requestJson<ChatSessionSummary>(
    '/chat/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    },
    token,
  )
}

export async function getChatSession(token: string, sessionId: number) {
  return requestJson<ChatSessionDetail>(
    `/chat/sessions/${sessionId}`,
    { method: 'GET' },
    token,
  )
}

export async function deleteChatSession(token: string, sessionId: number) {
  return requestJson<void>(
    `/chat/sessions/${sessionId}`,
    { method: 'DELETE' },
    token,
  )
}

export async function sendChatMessage(
  token: string,
  sessionId: number,
  content: string,
) {
  return requestJson<ChatReplyResponse>(
    `/chat/sessions/${sessionId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    },
    token,
  )
}

export async function sendSearchQuery(token: string, query: string) {
  return requestJson<SearchResponse>(
    `/search?query=${encodeURIComponent(query)}`,
    { method: 'GET' },
    token,
  )
}

export async function uploadDocumentSummary(
  token: string,
  file: File,
  sessionId: number | null = null,
) {
  const formData = new FormData()
  formData.append('file', file)
  if (sessionId !== null) {
    formData.append('session_id', String(sessionId))
  }

  return requestFormData<ChatReplyResponse>('/chat/documents', formData, token)
}
