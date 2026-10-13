import { describe, expect, it } from 'vitest';
import { DIRECTIONS, type Intent } from '@bomberman/game-engine';
import {
  botNameSchema,
  casualJoinPayload,
  decodeIntent,
  encodeIntent,
  registerBody,
  submitVersionBody,
} from '../src/index.ts';

describe('protocol schemas', () => {
  it('normalizes usernames and rejects invalid ones', () => {
    expect(registerBody.parse({ username: '  Alice_42 ', password: 'longenough' }).username).toBe(
      'alice_42',
    );
    expect(registerBody.safeParse({ username: 'a!', password: 'longenough' }).success).toBe(false);
    expect(registerBody.safeParse({ username: 'alice', password: 'short' }).success).toBe(false);
  });

  it('validates bot names and source sizes', () => {
    expect(botNameSchema.parse('  Tiny   Bomber ')).toBe('Tiny Bomber');
    expect(botNameSchema.safeParse('<script>').success).toBe(false);
    expect(submitVersionBody.safeParse({ source: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(submitVersionBody.parse({ source: 'function gameLoop(){}' }).visibility).toBe('private');
  });

  it('normalizes casual room codes', () => {
    expect(casualJoinPayload.parse({ code: ' ab12cd ' }).code).toBe('AB12CD');
    expect(casualJoinPayload.safeParse({ code: 'nope' }).success).toBe(false);
  });

  it('round trips compact intent codes', () => {
    const intents: Intent[] = [
      ...DIRECTIONS.map((direction) => ({ type: 'move', direction }) as Intent),
      { type: 'bomb' },
      { type: 'idle' },
    ];
    for (const intent of intents) expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
    expect(() => decodeIntent('x')).toThrow();
  });
});
