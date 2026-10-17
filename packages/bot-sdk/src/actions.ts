import { DIRECTIONS, type Direction, type Intent } from '@bomberman/game-engine';

/** A JSON-safe action as produced by bot code before validation. */
export type RawAction =
  | string
  | { type?: unknown; direction?: unknown; say?: unknown; message?: unknown }
  | null
  | undefined;

/** Longest chat message kept, after trimming; longer ones are cut. */
export const MAX_CHAT_LENGTH = 200;

const IDLE: Intent = { type: 'idle' };

function asDirection(value: unknown): Direction | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return (DIRECTIONS as readonly string[]).includes(lower) ? (lower as Direction) : null;
}

/**
 * Accepts the legacy strings (`"MOVE UP"`, `"PLANT BOMB"`, `"NOTHING"`) and objects
 * (`{ type: 'move', direction: 'up' }`, `{ type: 'bomb' }`). Anything else is idle.
 */
export function parseAction(raw: unknown): Intent {
  if (typeof raw === 'string') {
    const words = raw.trim().toLowerCase().split(/\s+/);
    if (words[0] === 'move') {
      const direction = asDirection(words[1]);
      return direction ? { type: 'move', direction } : IDLE;
    }
    if (words[0] === 'plant' || words[0] === 'bomb') return { type: 'bomb' };
    const direction = asDirection(words[0]);
    return direction ? { type: 'move', direction } : IDLE;
  }
  if (raw && typeof raw === 'object') {
    const { type, direction } = raw as { type?: unknown; direction?: unknown };
    if (type === 'move') {
      const parsed = asDirection(direction);
      return parsed ? { type: 'move', direction: parsed } : IDLE;
    }
    if (type === 'bomb' || type === 'plantBomb') return { type: 'bomb' };
  }
  return IDLE;
}

/** Strips control characters, collapses whitespace, and caps the length. Empty is `null`. */
export function sanitizeChat(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH)
    .trim();
  return clean.length > 0 ? clean : null;
}

/**
 * The chat line carried by an action, if any: `"SAY hi"` / `"CHAT hi"` (played as
 * idle), `{ type: 'say', message: 'hi' }`, or a `say` field next to a move or bomb.
 * Chat never changes what the bot does in the game.
 */
export function extractChat(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const match = /^\s*(?:say|chat)\s+([\s\S]+)$/i.exec(raw);
    return match ? sanitizeChat(match[1]) : null;
  }
  if (raw && typeof raw === 'object') {
    const { type, message, say } = raw as { type?: unknown; message?: unknown; say?: unknown };
    if (typeof say === 'string') return sanitizeChat(say);
    if (type === 'say' || type === 'chat') return sanitizeChat(message);
  }
  return null;
}
