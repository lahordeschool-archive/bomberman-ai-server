export const SKIN_COLORS = ['white', 'red', 'blue', 'black'] as const;

export interface SkinDefinition {
  slug: string;
  name: string;
  description: string;
  price: number;
}

/**
 * One ranked Elo point earned is worth five coins. At the usual 8–20 positive
 * Elo per match, the catalogue ranges from a couple of wins to a long-term goal.
 */
export const COINS_PER_ELO = 5;

export const SKINS = [
  { slug: 'ember', name: 'Ember', description: 'Hot coals and a glowing visor.', price: 150 },
  { slug: 'moss', name: 'Moss', description: 'A forest scout wrapped in leaves.', price: 250 },
  { slug: 'tide', name: 'Tide', description: 'Deep-sea armour with bright fins.', price: 400 },
  { slug: 'sunset', name: 'Sunset', description: 'Warm horizon stripes.', price: 650 },
  { slug: 'royal', name: 'Royal', description: 'Regal trim fit for an arena.', price: 900 },
  { slug: 'neon', name: 'Neon', description: 'Electric lines from the arcade.', price: 1250 },
  { slug: 'frost', name: 'Frost', description: 'Ice crystal plating.', price: 1750 },
  { slug: 'shadow', name: 'Shadow', description: 'A stealth hood and sharp eyes.', price: 2400 },
  { slug: 'galaxy', name: 'Galaxy', description: 'A tiny moving constellation.', price: 3300 },
  { slug: 'crown', name: 'Crown', description: 'The ultimate golden arena look.', price: 4500 },
] as const satisfies readonly SkinDefinition[];

export type SkinSlug = (typeof SKINS)[number]['slug'];

export function isSkinSlug(value: string): value is SkinSlug {
  return SKINS.some((skin) => skin.slug === value);
}

export function getSkin(slug: string): SkinDefinition | undefined {
  return SKINS.find((skin) => skin.slug === slug);
}
