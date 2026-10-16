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
      queued('same-second-owner', 'owner-b', 1205),
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
});
