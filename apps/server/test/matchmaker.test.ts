import { describe, expect, it } from 'vitest';
import { selectRankedEntrants } from '../src/arena/matchmaker.ts';
import type { QueueEntry } from '../src/store/bots.ts';

function queued(botId: string, ownerId: string, rating: number): QueueEntry {
  return {
    botId,
    ownerId,
    rating,
    botName: botId,
    versionId: `${botId}-version`,
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    lastMatchedAt: null,
    skin: null,
  };
}

describe('ranked entrant selection', () => {
  it('anchors on the longest-waiting bot and selects the closest ratings', () => {
    const queue = [
      queued('anchor', 'owner-a', 1200),
      queued('far', 'owner-b', 1500),
      queued('closest', 'owner-c', 1190),
      queued('close', 'owner-d', 1230),
      queued('closer', 'owner-e', 1180),
    ];

    expect(selectRankedEntrants(queue).map((entry) => entry.botId)).toEqual([
      'anchor',
      'closest',
      'closer',
      'close',
    ]);
  });

  it('allows only one bot per owner and keeps queue order for equal rating gaps', () => {
    const queue = [
      queued('anchor', 'owner-a', 1200),
      queued('same-owner-closest', 'owner-a', 1201),
      queued('first-tie', 'owner-b', 1180),
      queued('same-second-owner', 'owner-b', 1230),
      queued('second-tie', 'owner-c', 1220),
      queued('third', 'owner-d', 1230),
    ];

    expect(selectRankedEntrants(queue).map((entry) => entry.botId)).toEqual([
      'anchor',
      'first-tie',
      'second-tie',
      'third',
    ]);
  });

  it('returns one representative when every queued bot has the same owner', () => {
    const queue = [queued('oldest', 'owner-a', 1200), queued('newer', 'owner-a', 1201)];

    expect(selectRankedEntrants(queue).map((entry) => entry.botId)).toEqual(['oldest']);
  });

  it('waits when the globally longest-waiting bot is still playing', () => {
    const queue = [queued('oldest-busy', 'owner-a', 1200), queued('newer-free', 'owner-b', 1200)];

    expect(selectRankedEntrants(queue, new Set(['oldest-busy']))).toEqual([]);
  });

  it('waits rather than padding a partial human lineup while another bot is busy', () => {
    const queue = [
      queued('anchor', 'owner-a', 1200),
      queued('closest-busy', 'owner-b', 1201),
      queued('closest-free', 'owner-c', 1202),
      queued('other-free', 'owner-d', 1250),
    ];

    expect(selectRankedEntrants(queue, new Set(['closest-busy']))).toEqual([]);
  });

  it('starts another full human match while unrelated queued bots are busy', () => {
    const queue = [
      queued('anchor', 'owner-a', 1200),
      queued('busy', 'owner-b', 1201),
      queued('free-b', 'owner-c', 1202),
      queued('free-c', 'owner-d', 1203),
      queued('free-d', 'owner-e', 1204),
    ];

    expect(selectRankedEntrants(queue, new Set(['busy'])).map((entry) => entry.botId)).toEqual([
      'anchor',
      'free-b',
      'free-c',
      'free-d',
    ]);
  });
});
