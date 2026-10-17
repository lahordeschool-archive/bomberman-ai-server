import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import {
  inspectCompletedMatch,
  listIntegrityWarnings,
  sourceSimilarity,
} from '../src/store/integrity.ts';
import { createTestContext } from './helpers.ts';

let context: AppContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.db.close();
});

async function createPlayer(username: string): Promise<{ userId: string; botId: string }> {
  const userId = randomUUID();
  const botId = randomUUID();
  await context.db.query(
    `insert into users (id, username, display_name, password_hash)
     values ($1, $2, $2, '!')`,
    [userId, username],
  );
  await context.db.query('insert into bots (id, owner_id, name) values ($1, $2, $3)', [
    botId,
    userId,
    `${username} bot`,
  ]);
  return { userId, botId };
}

async function addCompletedMatch(
  participants: {
    userId: string;
    botId: string;
    placement: number;
    killedBySlot?: number;
    escapeAvailable?: boolean;
  }[],
): Promise<string> {
  const matchId = randomUUID();
  await context.db.query(
    `insert into matches
       (id, kind, status, engine_version, sdk_version, seed, player_count, settings,
        ended_at, end_tick, end_reason, winner_slot, final_hash, rated)
     values ($1, 'ranked', 'completed', 7, 1, 1, $2, $3, now(), 100,
             'lastStanding', 0, 'test', true)`,
    [
      matchId,
      participants.length,
      JSON.stringify({ bombs: 1, flames: 2, speed: 1, maxTicks: 100 }),
    ],
  );
  for (const [slot, participant] of participants.entries()) {
    await context.db.query(
      `insert into match_participants
         (match_id, slot, kind, bot_id, user_id, bot_name, placement,
          killed_by_slot, escape_available)
       values ($1, $2, 'ranked', $3, $4, $5, $6, $7, $8)`,
      [
        matchId,
        slot,
        participant.botId,
        participant.userId,
        `bot-${participant.botId}`,
        participant.placement,
        participant.killedBySlot ?? null,
        participant.escapeAvailable ?? false,
      ],
    );
  }
  return matchId;
}

describe('ranked integrity analysis', () => {
  it('compares token shingles rather than comments and whitespace', () => {
    const source = `
      function gameLoop(observation) {
        const safe = observation.players.filter((player) => player.alive);
        if (safe.length > 2) return "MOVE UP";
        return "PLANT BOMB";
      }
    `;
    expect(sourceSimilarity(source, `${source}\n// harmless change`)).toBe(1);
    expect(sourceSimilarity(source, 'function gameLoop() { return "IDLE"; }')).toBe(0);
  });

  it('warns on strong co-presence win-rate differences', async () => {
    const subject = await createPlayer('association_subject');
    const associate = await createPlayer('association_partner');
    const control = await createPlayer('association_control');
    let lastMatch = '';
    for (let index = 0; index < 4; index++) {
      lastMatch = await addCompletedMatch([
        { ...subject, placement: 1 },
        { ...associate, placement: 2 },
      ]);
    }
    for (let index = 0; index < 4; index++) {
      await addCompletedMatch([
        { ...subject, placement: 2 },
        { ...control, placement: 1 },
      ]);
    }

    await inspectCompletedMatch(context.db, lastMatch);
    expect(await listIntegrityWarnings(context.db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'win_association',
          severity: 'high',
          detail: expect.objectContaining({
            subjectBotId: subject.botId,
            associatedBotId: associate.botId,
            with: { matches: 4, wins: 4, rate: 1 },
            without: { matches: 4, wins: 0, rate: 0 },
          }),
        }),
      ]),
    );
  });

  it('warns after repeated deaths to one bot with an open escape tile', async () => {
    const victim = await createPlayer('death_victim');
    const killer = await createPlayer('death_killer');
    let lastMatch = '';
    for (let index = 0; index < 3; index++) {
      lastMatch = await addCompletedMatch([
        { ...victim, placement: 2, killedBySlot: 1, escapeAvailable: true },
        { ...killer, placement: 1 },
      ]);
    }

    await inspectCompletedMatch(context.db, lastMatch);
    expect(await listIntegrityWarnings(context.db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'repeated_avoidable_death',
          severity: 'medium',
          detail: expect.objectContaining({
            victimBotId: victim.botId,
            killerBotId: killer.botId,
            avoidableDeaths: 3,
          }),
        }),
      ]),
    );
  });
});
