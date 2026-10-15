import type { Intent, MatchResult, Snapshot } from '@bomberman/game-engine';
import { z } from 'zod';
import type { SkinSlug } from './skins.ts';

export const watchMatchPayload = z.object({ matchId: z.string().min(1).max(64) });

export const casualCreatePayload = z.object({
  botName: z.string().trim().min(1).max(32).default('Browser bot'),
  botId: z.uuid().optional(),
});

export const casualJoinPayload = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/),
  botName: z.string().trim().min(1).max(32).default('Browser bot'),
  botId: z.uuid().optional(),
});

export const casualStartPayload = z.object({
  houseBots: z.array(z.string().max(32)).max(3).default([]),
});

/** What a browser bot may answer to `bot:observe`; parsed again with `parseAction`. */
export const rawActionPayload = z.union([
  z.string().max(64),
  z.object({
    type: z.string().max(16).nullable().optional(),
    direction: z.string().max(16).nullable().optional(),
  }),
  z.null(),
]);

export interface MatchParticipantInfo {
  slot: number;
  name: string;
  owner: string | null;
  kind: 'ranked' | 'browser' | 'house';
  skin: SkinSlug | null;
}

export interface MatchInit {
  matchId: string;
  kind: 'ranked' | 'casual' | 'tournament';
  participants: MatchParticipantInfo[];
  /** The match ends on a timeout when the snapshot tick reaches this. */
  maxTicks: number;
  snapshot: Snapshot;
}

export interface LiveSnapshot {
  matchId: string;
  snapshot: Snapshot;
}

export interface CasualLobby {
  code: string;
  hostUserId: string;
  members: { userId: string; displayName: string; botName: string }[];
  status: 'waiting' | 'playing';
  matchId: string | null;
}

export type Ack<T> = (response: { ok: true; data: T } | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  'match:watch': (payload: unknown, ack: Ack<MatchInit>) => void;
  'match:unwatch': (payload: unknown) => void;
  'casual:create': (payload: unknown, ack: Ack<CasualLobby>) => void;
  'casual:join': (payload: unknown, ack: Ack<CasualLobby>) => void;
  'casual:leave': () => void;
  'casual:start': (payload: unknown, ack: Ack<{ matchId: string }>) => void;
}

export interface ServerToClientEvents {
  'match:init': (init: MatchInit) => void;
  'match:snapshot': (live: LiveSnapshot) => void;
  'match:end': (payload: { matchId: string; result: MatchResult }) => void;
  'casual:lobby': (lobby: CasualLobby | null) => void;
  'casual:match': (payload: { matchId: string; slot: number }) => void;
  'bot:observe': (
    payload: { matchId: string; observation: unknown; budgetMs: number },
    ack: (action: unknown) => void,
  ) => void;
}

const INTENT_CODES = {
  u: { type: 'move', direction: 'up' },
  d: { type: 'move', direction: 'down' },
  l: { type: 'move', direction: 'left' },
  r: { type: 'move', direction: 'right' },
  b: { type: 'bomb' },
  i: { type: 'idle' },
} as const satisfies Record<string, Intent>;

export function encodeIntent(intent: Intent): string {
  if (intent.type === 'bomb') return 'b';
  if (intent.type === 'idle') return 'i';
  return intent.direction[0]!;
}

export function decodeIntent(code: string): Intent {
  const intent = INTENT_CODES[code as keyof typeof INTENT_CODES];
  if (!intent) throw new Error(`Unknown intent code ${code}`);
  return { ...intent };
}
