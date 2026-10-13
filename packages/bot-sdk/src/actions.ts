import { DIRECTIONS, type Direction, type Intent } from '@bomberman/game-engine';

/** A JSON-safe action as produced by bot code before validation. */
export type RawAction = string | { type?: unknown; direction?: unknown } | null | undefined;

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
