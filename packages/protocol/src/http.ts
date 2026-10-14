import { z } from 'zod';

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(
    z.string().regex(USERNAME_PATTERN, 'Use 3 to 24 lowercase letters, digits, or underscores'),
  );

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(200, 'Use at most 200 characters');

export const displayNameSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(32));

export const emailSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3, 'Enter a valid email address')
      .max(254, 'Enter a valid email address')
      .email('Enter a valid email address'),
  );

export const registerBody = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: emailSchema,
  displayName: displayNameSchema.optional(),
});

export const loginBody = z.object({
  username: z.string().max(64).transform(normalizeUsername),
  password: z.string().max(200),
});

export const changePasswordBody = z.object({
  currentPassword: z.string().max(200),
  newPassword: passwordSchema,
});

export const botNameSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2)
      .max(32)
      .regex(/^[\p{L}\p{N} _.'-]+$/u, "Use letters, digits, spaces, and . _ ' -"),
  );

export const createBotBody = z.object({ name: botNameSchema });
export const updateBotBody = z.object({ name: botNameSchema });

export const visibilitySchema = z.enum(['private', 'public']);

export const submitVersionBody = z.object({
  source: z
    .string()
    .min(1)
    .max(64 * 1024),
  visibility: visibilitySchema.default('private'),
  label: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((label) => label || null),
});

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const matchListQuery = paginationQuery.extend({
  botId: z.uuid().optional(),
  username: z.string().max(64).transform(normalizeUsername).optional(),
});

export const idParam = z.object({ id: z.uuid() });
export const versionParam = z.object({ id: z.uuid(), versionId: z.uuid() });

export type UserRole = 'player' | 'moderator' | 'admin';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  /** Present on session/admin responses; omitted from public profiles. */
  email?: string | null;
  createdAt: string;
  role: UserRole;
}

export interface SessionResponse {
  user: PublicUser | null;
  csrfToken: string | null;
}

export interface BotSummary {
  id: string;
  name: string;
  owner: { username: string; displayName: string; isHouse: boolean };
  activeVersion: { id: string; version: number; label: string | null; createdAt: string } | null;
  rating: { rating: number; games: number; wins: number } | null;
  queued: boolean;
  createdAt: string;
}

export interface BotVersionSummary {
  id: string;
  version: number;
  label: string | null;
  sourceHash: string;
  sdkVersion: number;
  visibility: 'private' | 'public';
  createdAt: string;
}

export interface BotVersionDetail extends BotVersionSummary {
  source: string | null;
}

export interface BotDetail extends BotSummary {
  versions: BotVersionSummary[];
}

export interface LeaderboardEntry {
  rank: number;
  botId: string;
  botName: string;
  owner: { username: string; displayName: string; isHouse: boolean };
  rating: number;
  games: number;
  wins: number;
}

export interface MatchParticipantSummary {
  slot: number;
  botId: string | null;
  botName: string;
  botVersion: number | null;
  owner: { username: string; displayName: string; isHouse: boolean } | null;
  placement: number | null;
  score: number | null;
  kills: number | null;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

export interface MatchSummary {
  id: string;
  kind: 'ranked' | 'casual' | 'tournament';
  status: 'running' | 'completed' | 'aborted';
  tournament: { id: string; slug: string; name: string } | null;
  startedAt: string;
  endedAt: string | null;
  endTick: number | null;
  winnerSlot: number | null;
  participants: MatchParticipantSummary[];
}

export interface ReplayResponse {
  matchId: string;
  engineVersion: number;
  seed: number;
  playerCount: number;
  settings: { bombs: number; flames: number; speed: number; maxTicks: number };
  finalHash: string;
  intents: [tick: number, slot: number, intent: string][];
}

export interface RankedStatus {
  queue: { botId: string; botName: string; enqueuedAt: string }[];
  queueLength: number;
  liveMatches: MatchSummary[];
}

export interface Achievement {
  slug: string;
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
}

export interface TournamentStanding {
  rank: number;
  botId: string;
  botName: string;
  owner: { username: string; displayName: string };
  games: number;
  wins: number;
  points: number;
  activeVersion: number;
}

export interface TournamentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  state: 'upcoming' | 'active' | 'finished' | 'cancelled';
  entrants: number;
}

export interface TournamentDetail extends TournamentSummary {
  standings: TournamentStanding[];
}

export const createTournamentBody = z
  .object({
    name: z.string().trim().min(3).max(80),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]{3,48}$/),
    description: z.string().trim().max(1000).default(''),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: 'The tournament must end after it starts.',
    path: ['endsAt'],
  });

export const tournamentSlugParam = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{3,48}$/),
});

export const tournamentRegistrationBody = z.object({ botId: z.uuid() });

export const updateRoleBody = z.object({
  role: z.enum(['player', 'moderator', 'admin']),
});

export interface AdminOverview {
  counts: { users: number; bots: number; liveMatches: number; tournaments: number };
  users: PublicUser[];
  audit: {
    id: string;
    actor: string | null;
    action: string;
    detail: Record<string, unknown> | null;
    createdAt: string;
  }[];
  liveMatches: MatchSummary[];
}

export interface ApiError {
  error: string;
  message: string;
  issues?: { path: string; message: string }[];
}
