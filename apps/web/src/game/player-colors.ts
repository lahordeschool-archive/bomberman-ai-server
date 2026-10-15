import { getSkin, type SkinSlug } from '@bomberman/protocol';

type ColorFamily =
  | 'white'
  | 'black'
  | 'blue'
  | 'red'
  | 'orange'
  | 'green'
  | 'cyan'
  | 'pink'
  | 'purple'
  | 'yellow';

interface ColorChoice {
  family: ColorFamily;
  swatch: string;
}

export interface PlayerColorInput {
  slot: number;
  skin?: SkinSlug | null;
}

/** Dominant colors from the untinted (`white`) variant generated for each skin. */
const SKIN_COLORS: Record<SkinSlug, ColorChoice> = {
  ember: { family: 'orange', swatch: '#FF7018' },
  moss: { family: 'green', swatch: '#44A848' },
  tide: { family: 'blue', swatch: '#18AED6' },
  sunset: { family: 'pink', swatch: '#F46280' },
  royal: { family: 'purple', swatch: '#8448D6' },
  neon: { family: 'green', swatch: '#1EEBB0' },
  frost: { family: 'blue', swatch: '#8EDAFF' },
  shadow: { family: 'black', swatch: '#665A80' },
  galaxy: { family: 'purple', swatch: '#5654C8' },
  crown: { family: 'yellow', swatch: '#E6A41A' },
};

const CLASSIC_COLOR: ColorChoice = { family: 'white', swatch: '#E8E8E8' };

/** High-contrast alternatives, ordered to preserve the historical arena palette first. */
const FALLBACK_COLORS: readonly ColorChoice[] = [
  CLASSIC_COLOR,
  { family: 'black', swatch: '#5B5B5B' },
  { family: 'blue', swatch: '#4D8DF7' },
  { family: 'red', swatch: '#F25555' },
  { family: 'green', swatch: '#56C271' },
  { family: 'orange', swatch: '#FF8A3D' },
  { family: 'purple', swatch: '#A875F5' },
  { family: 'yellow', swatch: '#F0C94D' },
  { family: 'pink', swatch: '#F46280' },
  { family: 'cyan', swatch: '#32C8E6' },
];

function preferredColor(skin?: SkinSlug | null): ColorChoice {
  return skin ? SKIN_COLORS[skin] : CLASSIC_COLOR;
}

function skinPrice(skin?: SkinSlug | null): number {
  return skin ? (getSkin(skin)?.price ?? 0) : 0;
}

/**
 * Uses each skin's dominant color when it is unambiguous. If several players have
 * the same color family, the most expensive skin keeps it; equal prices favor the
 * lower slot. Other players receive distinct, high-contrast fallback colors.
 */
export function assignPlayerColors(players: readonly PlayerColorInput[]): Map<number, string> {
  const ordered = [...players].sort(
    (left, right) => skinPrice(right.skin) - skinPrice(left.skin) || left.slot - right.slot,
  );
  const assignments = new Map<number, string>();
  const usedFamilies = new Set<ColorFamily>();
  const conflicts: PlayerColorInput[] = [];

  for (const player of ordered) {
    const preferred = preferredColor(player.skin);
    if (usedFamilies.has(preferred.family)) {
      conflicts.push(player);
      continue;
    }
    assignments.set(player.slot, preferred.swatch);
    usedFamilies.add(preferred.family);
  }

  for (const player of conflicts) {
    const fallback = FALLBACK_COLORS.find((color) => !usedFamilies.has(color.family));
    if (!fallback) throw new Error('No distinct player indicator color is available.');
    assignments.set(player.slot, fallback.swatch);
    usedFamilies.add(fallback.family);
  }

  return assignments;
}
