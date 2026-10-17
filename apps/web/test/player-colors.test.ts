import { describe, expect, it } from 'vitest';
import { assignPlayerColors } from '../src/game/player-colors.ts';

describe('player indicator colors', () => {
  it('uses each skin dominant color when color families are distinct', () => {
    const colors = assignPlayerColors([
      { slot: 0, skin: 'ember' },
      { slot: 1, skin: 'moss' },
      { slot: 2, skin: 'tide' },
      { slot: 3, skin: 'crown' },
    ]);

    expect([...colors.entries()].sort()).toEqual([
      [0, '#FF7018'],
      [1, '#44A848'],
      [2, '#18AED6'],
      [3, '#E6A41A'],
    ]);
  });

  it('lets the more expensive skin keep a shared color family', () => {
    const colors = assignPlayerColors([
      { slot: 0, skin: 'moss' },
      { slot: 1, skin: 'neon' },
      { slot: 2, skin: null },
    ]);

    expect(colors.get(1)).toBe('#1EEBB0');
    expect(colors.get(2)).toBe('#E8E8E8');
    expect(colors.get(0)).toBe('#5B5B5B');
  });

  it('lets Duck keep yellow when paired with Crown', () => {
    const colors = assignPlayerColors([
      { slot: 0, skin: 'crown' },
      { slot: 1, skin: 'duck' },
    ]);

    expect(colors.get(1)).toBe('#F7CF2C');
    expect(colors.get(0)).toBe('#E8E8E8');
  });

  it('uses slot order as the stable tie-breaker for identical skins', () => {
    const colors = assignPlayerColors([
      { slot: 3, skin: 'royal' },
      { slot: 1, skin: 'royal' },
    ]);

    expect(colors.get(1)).toBe('#8448D6');
    expect(colors.get(3)).toBe('#E8E8E8');
  });

  it('preserves the historical palette for players without skins', () => {
    const colors = assignPlayerColors([{ slot: 0 }, { slot: 1 }, { slot: 2 }, { slot: 3 }]);

    expect([...colors.entries()].sort()).toEqual([
      [0, '#E8E8E8'],
      [1, '#5B5B5B'],
      [2, '#4D8DF7'],
      [3, '#F25555'],
    ]);
  });
});
