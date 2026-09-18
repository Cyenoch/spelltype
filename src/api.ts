import type {
  MatchCancelResult,
  MatchTicket,
  Profile,
  RoomSnapshot,
  SessionInfo,
  User,
  Difficulty,
} from '../shared/protocol';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  /** Session is gone (expired or revoked) — the UI must re-authenticate. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

function extractError(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error: unknown }).error;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '网络请求失败，请检查网络连接后重试。');
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractError(payload) ?? `服务器返回错误（HTTP ${response.status}）。`,
    );
  }
  return payload as T;
}

export const api = {
  session: () => request<SessionInfo>('GET', '/api/session'),
  login: (username: string, password: string) =>
    request<{ user: User }>('POST', '/api/login', { username, password }),
  register: (username: string, password: string) =>
    request<{ user: User }>('POST', '/api/register', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),
  profile: () => request<Profile>('GET', '/api/profile'),
  createRoom: (theme: string, difficulty: Difficulty) =>
    request<{ roomId: string }>('POST', '/api/rooms', { theme, difficulty }),
  room: (roomId: string) => request<RoomSnapshot>('GET', `/api/rooms/${roomId}`),
  enqueue: (difficulty: Difficulty) => request<MatchTicket>('POST', '/api/match', { difficulty }),
  cancelMatch: () => request<MatchCancelResult>('DELETE', '/api/match'),
};

export type Api = typeof api;
