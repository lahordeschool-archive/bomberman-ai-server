import type {
  ApiError,
  BotDetail,
  BotSummary,
  BotVersionDetail,
  LeaderboardEntry,
  MatchSummary,
  PublicUser,
  RankedStatus,
  ReplayResponse,
  SessionResponse,
} from '@bomberman/protocol';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiError['issues'];

  constructor(status: number, body: Partial<ApiError>) {
    super(body.message ?? 'Request failed. Please try again.');
    this.status = status;
    this.code = body.error ?? 'error';
    this.issues = body.issues;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(0, { message: 'Could not reach the server. Check your connection.' });
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!response.ok) throw new RequestError(response.status, data);
  return data;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  session: () => request<SessionResponse>('GET', '/api/auth/session'),
  register: (body: { username: string; password: string; displayName?: string }) =>
    request<SessionResponse>('POST', '/api/auth/register', body),
  login: (body: { username: string; password: string }) =>
    request<SessionResponse>('POST', '/api/auth/login', body),
  logout: () => request<void>('POST', '/api/auth/logout'),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<SessionResponse>('POST', '/api/auth/password', body),

  myBots: () => request<{ bots: BotSummary[] }>('GET', '/api/bots'),
  createBot: (name: string) => request<BotDetail>('POST', '/api/bots', { name }),
  bot: (id: string) => request<BotDetail>('GET', `/api/bots/${id}`),
  renameBot: (id: string, name: string) => request<BotDetail>('PATCH', `/api/bots/${id}`, { name }),
  deleteBot: (id: string) => request<void>('DELETE', `/api/bots/${id}`),
  version: (botId: string, versionId: string) =>
    request<BotVersionDetail>('GET', `/api/bots/${botId}/versions/${versionId}`),
  submitVersion: (botId: string, source: string, visibility: 'private' | 'public') =>
    request<BotVersionDetail>('POST', `/api/bots/${botId}/versions`, { source, visibility }),
  enqueue: (botId: string) => request<RankedStatus>('POST', `/api/bots/${botId}/ranked`),
  dequeue: (botId: string) => request<RankedStatus>('DELETE', `/api/bots/${botId}/ranked`),

  rankedStatus: () => request<RankedStatus>('GET', '/api/ranked/status'),
  leaderboard: (limit: number, offset: number) =>
    request<{ entries: LeaderboardEntry[]; total: number }>(
      'GET',
      `/api/leaderboard${query({ limit, offset })}`,
    ),
  matches: (params: { limit?: number; offset?: number; botId?: string; username?: string }) =>
    request<{ matches: MatchSummary[]; total: number }>('GET', `/api/matches${query(params)}`),
  liveMatches: () => request<{ matches: MatchSummary[] }>('GET', '/api/matches/live'),
  match: (id: string) => request<MatchSummary>('GET', `/api/matches/${id}`),
  replay: (id: string) => request<ReplayResponse>('GET', `/api/matches/${id}/replay`),
  profile: (username: string) =>
    request<{ user: PublicUser; bots: BotSummary[] }>('GET', `/api/users/${username}`),
};
