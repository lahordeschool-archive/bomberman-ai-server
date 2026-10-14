export const ELO_K = 32;
/** Decisive engine-v6+ wins move the ladder 25% more than timeout placements. */
export const DECISIVE_ELO_K = 40;

export interface EloEntrant {
  rating: number;
  /** 1 is best; equal placements are ties. */
  placement: number;
}

/**
 * Multiplayer Elo: every pair of entrants is scored as a head-to-head game
 * (win 1, tie 0.5, loss 0), and the summed deviation from the expected score is
 * scaled by K / (n - 1) so a match moves ratings as much as one duel would.
 */
export function multiplayerElo(entrants: readonly EloEntrant[], k = ELO_K): number[] {
  const n = entrants.length;
  if (n < 2) return entrants.map((entrant) => entrant.rating);
  return entrants.map((self, i) => {
    let delta = 0;
    entrants.forEach((other, j) => {
      if (i === j) return;
      const expected = 1 / (1 + 10 ** ((other.rating - self.rating) / 400));
      const actual =
        self.placement < other.placement ? 1 : self.placement === other.placement ? 0.5 : 0;
      delta += actual - expected;
    });
    return self.rating + (k / (n - 1)) * delta;
  });
}
