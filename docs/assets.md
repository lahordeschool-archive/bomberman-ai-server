# Asset licensing

The code in this repository is MIT licensed. **The game art and audio are not.**

| Files                                                                    | Origin                                                                                    | Status                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------- |
| `apps/web/public/game/sprites/snes_*.png`                                | Super Bomberman (SNES) sprite rips, via The Spriters Resource, recolored for this project | Not licensed for reuse  |
| `apps/web/public/game/tiles/snes_stage_1.png`                            | Super Bomberman (SNES) stage tiles, same source                                           | Not licensed for reuse  |
| `apps/web/public/game/sprites/*_wall_destroyed.png`, `sprite_bomberman/` | Edits of the sprites above                                                                | Derivative, same status |
| `apps/web/public/game/audio/snes_battle_music.mp3`                       | Super Bomberman battle theme                                                              | Not licensed for reuse  |
| `apps/web/public/game/audio/explosion.mp3`                               | Unknown origin                                                                            | Unverified              |

Bomberman is a trademark of Konami (formerly Hudson Soft). Fan rips from sprite
archives remain the property of their rights holders; the archive does not grant a
license.

## What this means

- Fine for a private workshop or a closed group, as the original project was.
- **Not fine for a public website.** Before opening the platform publicly, replace
  these files with original or openly licensed art (CC0 or CC BY), and avoid the
  "Bomberman" name in the product (the platform already uses "Bomber Arena").

## Replacing the art

The renderer (`apps/web/src/game/renderer.ts`) expects the same layout:

- Player sheets: 17×26 frames; frames 0 to 11 are four walking directions of 3
  frames each, frames 12 to 17 the death animation. One sheet per color (white,
  black, blue, red).
- Bomb sheets: 16×16, 4 frames. Destroyed wall sheets: 16×16, 6 frames.
- Flame sheets: 16×16 frames, 5 frames per flame kind starting at frame 5 (center,
  vertical, horizontal, then the up, down, right, left end caps); see
  `FLAME_ANIMATIONS` in the renderer.
- Items: a 16×16 sheet; frame indices per item type are in `ITEM_SPRITE_FRAMES`
  (`packages/game-engine/src/constants.ts`).
- Stage tiles: a 16×16 tileset with floor, indestructible wall, and destructible wall.

Good CC0 starting points: Kenney's pixel packs and OpenGameArt's CC0 tag. Record the
source and license of every replacement in this file.
