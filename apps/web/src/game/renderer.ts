import Phaser from 'phaser';
import {
  Cell,
  type FlameKind,
  GRID_HEIGHT,
  GRID_WIDTH,
  ITEM_SPRITE_FRAMES,
  PLAYER_COLORS,
  type Snapshot,
  type SnapshotPlayer,
  TICK_MS,
  TILE_SIZE,
} from '@bomberman/game-engine';
import { SKINS, type SkinSlug } from '@bomberman/protocol';

const WIDTH = GRID_WIDTH * TILE_SIZE;
const HEIGHT = GRID_HEIGHT * TILE_SIZE;
const ASSETS = '/game';

const TILE_FRAMES = { hard: 1, soft: 2, grass: 3, shadow: 4 } as const;
const IDLE_FRAMES = { up: 1, left: 4, down: 7, right: 10 } as const;
const FLAME_ANIMATIONS: Record<FlameKind, { name: string; frames: number[] }> = {
  center: { name: 'center', frames: [5, 6, 7, 8, 9, 8, 7, 6, 5] },
  vertical: { name: 'ud-body', frames: [10, 11, 12, 13, 14, 13, 12, 11, 10] },
  horizontal: { name: 'lr-body', frames: [15, 16, 17, 18, 19, 18, 17, 16, 15] },
  endUp: { name: 'up-head', frames: [20, 21, 22, 23, 24, 23, 22, 21, 20] },
  endDown: { name: 'down-head', frames: [25, 26, 27, 28, 29, 28, 27, 26, 25] },
  endRight: { name: 'right-head', frames: [30, 31, 32, 33, 34, 33, 32, 31, 30] },
  endLeft: { name: 'left-head', frames: [35, 36, 37, 38, 39, 38, 37, 36, 35] },
};

const colorOf = (playerId: number) => PLAYER_COLORS[playerId % PLAYER_COLORS.length]!;
const cellKey = (x: number, y: number) => `${x},${y}`;
const tileKey = (theme: Snapshot['theme'], kind: 'floor' | 'hard' | 'soft') =>
  theme === 'grass' ? 'tiles' : `${theme}-${kind}`;

interface PlayerSprite {
  sprite: Phaser.GameObjects.Sprite;
  targetX: number;
  targetY: number;
  alive: boolean;
  facing: SnapshotPlayer['facing'];
  appearance: string;
}

class ArenaScene extends Phaser.Scene {
  private ready = false;
  private queued: { snapshot: Snapshot; instant: boolean } | null = null;
  private background: Phaser.GameObjects.Image[] = [];
  private arenaKey = '';
  private arenaGrid = '';
  private arenaHeight = HEIGHT;
  private walls = new Map<number, Phaser.GameObjects.Sprite>();
  private items = new Map<string, Phaser.GameObjects.Sprite>();
  private bombs = new Map<number, { sprite: Phaser.GameObjects.Sprite; ownerId: number }>();
  private flames = new Map<
    string,
    { sprite: Phaser.GameObjects.Sprite; kind: FlameKind; ownerId: number; appearance: string }
  >();
  private players = new Map<number, PlayerSprite>();
  private markers = new Map<number, Phaser.GameObjects.Graphics>();
  private highlighted: readonly number[] = [];
  private playerSkins = new Map<number, SkinSlug>();
  private halted = false;
  muted = true;

  constructor() {
    super('arena');
  }

  preload(): void {
    for (const color of PLAYER_COLORS) {
      this.load.spritesheet(`${color}-bm`, `${ASSETS}/sprites/snes_${color}.png`, {
        frameWidth: 17,
        frameHeight: 26,
      });
      this.load.spritesheet(`${color}-bomb`, `${ASSETS}/sprites/snes_bombs_${color}.png`, {
        frameWidth: 16,
        frameHeight: 16,
      });
      this.load.spritesheet(`${color}-flame`, `${ASSETS}/sprites/snes_flames_${color}.png`, {
        frameWidth: 16,
        frameHeight: 16,
      });
      this.load.spritesheet(`${color}-wall`, `${ASSETS}/sprites/${color}_wall_destroyed.png`, {
        frameWidth: 16,
        frameHeight: 16,
      });
      for (const skin of SKINS) {
        this.load.spritesheet(
          `${skin.slug}-${color}-bm`,
          `${ASSETS}/skins/${skin.slug}_${color}.png`,
          { frameWidth: 17, frameHeight: 26 },
        );
        this.load.spritesheet(
          `${skin.slug}-${color}-bomb`,
          `${ASSETS}/skins/${skin.slug}_${color}_bomb.png`,
          { frameWidth: 16, frameHeight: 16 },
        );
        this.load.spritesheet(
          `${skin.slug}-${color}-flame`,
          `${ASSETS}/skins/${skin.slug}_${color}_flame.png`,
          { frameWidth: 16, frameHeight: 16 },
        );
      }
    }
    this.load.spritesheet('tiles', `${ASSETS}/tiles/snes_stage_1.png`, {
      frameWidth: 16,
      frameHeight: 16,
    });
    this.load.spritesheet('items', `${ASSETS}/sprites/snes_items.png`, {
      frameWidth: 16,
      frameHeight: 16,
    });
    this.load.audio('explosion', `${ASSETS}/audio/explosion.mp3`);
  }

  create(): void {
    for (const color of PLAYER_COLORS) {
      this.createPlayerAnimations(`${color}-bm`, color);
      for (const skin of SKINS) {
        this.createPlayerAnimations(`${skin.slug}-${color}-bm`, `${skin.slug}-${color}`);
        this.createEffectAnimations(`${skin.slug}-${color}`);
      }
      this.createWorldAnimations(color);
    }

    this.createThemeTextures();
    this.ready = true;
    this.setHighlighted(this.highlighted);
    if (this.queued) {
      this.apply(this.queued.snapshot, this.queued.instant);
      this.queued = null;
    }
  }

  private createPlayerAnimations(texture: string, prefix: string): void {
    const walk = (key: string, start: number) =>
      this.anims.create({
        key: `${prefix}-${key}`,
        frames: this.anims.generateFrameNumbers(texture, { start, end: start + 2 }),
        frameRate: 8,
        repeat: -1,
      });
    walk('up', 0);
    walk('left', 3);
    walk('down', 6);
    walk('right', 9);
    this.anims.create({
      key: `${prefix}-death`,
      frames: this.anims.generateFrameNumbers(texture, { start: 12, end: 17 }),
      frameRate: 8,
      repeat: 0,
    });
  }

  private createWorldAnimations(color: string): void {
    this.createEffectAnimations(color);
    this.anims.create({
      key: `${color}-wall-destroyed`,
      frames: this.anims.generateFrameNumbers(`${color}-wall`, { start: 0, end: 5 }),
      frameRate: 12,
      repeat: 0,
    });
  }

  private createEffectAnimations(appearance: string): void {
    this.anims.create({
      key: `${appearance}-bomb-ticking`,
      frames: this.anims.generateFrameNumbers(`${appearance}-bomb`, { start: 0, end: 3 }),
      frameRate: 3,
      repeat: -1,
    });
    for (const animation of Object.values(FLAME_ANIMATIONS)) {
      this.anims.create({
        key: `${appearance}-flame-${animation.name}`,
        frames: this.anims.generateFrameNumbers(`${appearance}-flame`, {
          frames: animation.frames,
        }),
        frameRate: 18,
        repeat: -1,
      });
    }
  }

  override update(time: number, delta: number): void {
    const factor = Math.min(1, delta / (TICK_MS * 1.5));
    for (const entry of this.players.values()) {
      const { sprite } = entry;
      sprite.x += (entry.targetX - sprite.x) * factor;
      sprite.y += (entry.targetY - sprite.y) * factor;
      sprite.setDepth(10 + sprite.y / this.arenaHeight);
    }
    const bob = this.halted ? 0 : Math.round(Math.sin(time / 180) * 1.5);
    for (const [slot, marker] of this.markers) {
      const entry = this.players.get(slot);
      const visible = Boolean(entry?.alive && entry.sprite.visible);
      marker.setVisible(visible);
      if (entry && visible) {
        marker.setPosition(
          Math.round(entry.sprite.x),
          Math.max(5, Math.round(entry.sprite.y) - 22 + bob),
        );
      }
    }
  }

  /** Draws a small red arrow above the given player slots (your own bots). */
  setHighlighted(slots: readonly number[]): void {
    this.highlighted = slots;
    if (!this.ready) return;
    for (const [slot, marker] of this.markers) {
      if (!slots.includes(slot)) {
        marker.destroy();
        this.markers.delete(slot);
      }
    }
    for (const slot of slots) {
      if (this.markers.has(slot)) continue;
      const marker = this.add.graphics().setDepth(100).setVisible(false);
      marker.fillStyle(0x000000, 0.75);
      marker.fillTriangle(-6, -5, 6, -5, 0, 3);
      marker.fillStyle(0xff3b30, 1);
      marker.fillTriangle(-5, -4, 5, -4, 0, 1);
      this.markers.set(slot, marker);
    }
  }

  setPlayerSkins(skins: ReadonlyMap<number, SkinSlug>): void {
    this.playerSkins = new Map(skins);
    for (const [slot, entry] of this.players) {
      const color = colorOf(slot);
      const skin = this.playerSkins.get(slot);
      const appearance = skin ? `${skin}-${color}` : color;
      if (entry.appearance === appearance) continue;
      entry.appearance = appearance;
      entry.sprite.setTexture(`${appearance}-bm`, entry.sprite.frame.name);
    }
    for (const entry of this.bombs.values()) {
      const appearance = this.appearanceOf(entry.ownerId);
      entry.sprite.setTexture(`${appearance}-bomb`, entry.sprite.frame.name);
      entry.sprite.play(`${appearance}-bomb-ticking`);
    }
    for (const entry of this.flames.values()) {
      const appearance = this.appearanceOf(entry.ownerId);
      if (appearance === entry.appearance) continue;
      entry.appearance = appearance;
      entry.sprite.setTexture(`${appearance}-flame`);
      entry.sprite.play(`${appearance}-flame-${FLAME_ANIMATIONS[entry.kind].name}`);
    }
  }

  private appearanceOf(playerId: number): string {
    const color = colorOf(playerId);
    const skin = this.playerSkins.get(playerId);
    return skin ? `${skin}-${color}` : color;
  }

  clearAll(): void {
    for (const sprite of this.walls.values()) sprite.destroy();
    for (const sprite of this.items.values()) sprite.destroy();
    for (const { sprite } of this.bombs.values()) sprite.destroy();
    for (const { sprite } of this.flames.values()) sprite.destroy();
    for (const { sprite } of this.players.values()) sprite.destroy();
    this.walls.clear();
    this.items.clear();
    this.bombs.clear();
    this.flames.clear();
    this.players.clear();
    this.halted = false;
  }

  /**
   * Freezes the arena when no more snapshots will come (stopped, paused, or over):
   * walking players stand still and bombs and flames stop animating.
   */
  halt(): void {
    if (!this.ready) return;
    this.halted = true;
    for (const entry of this.players.values()) {
      if (!entry.alive) continue;
      entry.sprite.anims.stop();
      entry.sprite.setFrame(IDLE_FRAMES[entry.facing]);
    }
    for (const { sprite } of this.bombs.values()) sprite.anims.pause();
    for (const { sprite } of this.flames.values()) sprite.anims.pause();
  }

  apply(snapshot: Snapshot, instant: boolean): void {
    if (!this.ready) {
      this.queued = { snapshot, instant };
      return;
    }
    this.syncArena(snapshot);
    if (this.halted) {
      this.halted = false;
      for (const { sprite } of this.bombs.values()) sprite.anims.resume();
      for (const { sprite } of this.flames.values()) sprite.anims.resume();
    }
    const wallOwners = new Map<number, number>();
    for (const event of snapshot.events) {
      if (event.type === 'wallDestroyed')
        wallOwners.set(event.y * snapshot.width + event.x, event.by);
      if (event.type === 'bombExploded' && !instant && !this.muted) {
        this.sound.play('explosion', { volume: 0.25 });
      }
    }
    this.syncWalls(snapshot, wallOwners, instant);
    this.syncItems(snapshot);
    this.syncBombs(snapshot);
    this.syncFlames(snapshot);
    for (const player of snapshot.players) this.syncPlayer(player, instant);
    if (snapshot.status === 'finished') this.halt();
  }

  private syncWalls(snapshot: Snapshot, owners: Map<number, number>, instant: boolean): void {
    for (let index = 0; index < snapshot.grid.length; index++) {
      const isSoft = Number(snapshot.grid[index]) === Cell.Soft;
      const sprite = this.walls.get(index);
      if (isSoft && !sprite) {
        const x = (index % snapshot.width) * TILE_SIZE;
        const y = Math.floor(index / snapshot.width) * TILE_SIZE;
        const texture = tileKey(snapshot.theme, 'soft');
        this.walls.set(
          index,
          this.add
            .sprite(x, y, texture, snapshot.theme === 'grass' ? TILE_FRAMES.soft : 0)
            .setOrigin(0, 0)
            .setDepth(1),
        );
      } else if (!isSoft && sprite) {
        this.walls.delete(index);
        const becameHard = Number(snapshot.grid[index]) === Cell.Hard;
        if (instant || becameHard) {
          sprite.destroy();
        } else if (snapshot.theme === 'grass') {
          sprite.play(`${colorOf(owners.get(index) ?? 0)}-wall-destroyed`);
          sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => sprite.destroy());
        } else {
          this.tweens.add({
            targets: sprite,
            alpha: 0,
            scale: 0.5,
            duration: 180,
            onComplete: () => sprite.destroy(),
          });
        }
      }
    }
  }

  private syncArena(snapshot: Snapshot): void {
    const key = `${snapshot.width}x${snapshot.height}:${snapshot.theme}`;
    const rebuild = key !== this.arenaKey;
    if (!rebuild && snapshot.grid === this.arenaGrid) return;
    if (rebuild) {
      this.clearAll();
      for (const tile of this.background) tile.destroy();
      this.background = [];
      this.arenaKey = key;
      this.arenaHeight = snapshot.height * TILE_SIZE;
    }

    for (let index = 0; index < snapshot.grid.length; index++) {
      const x = index % snapshot.width;
      const y = Math.floor(index / snapshot.width);
      const hard = Number(snapshot.grid[index]) === Cell.Hard;
      if (snapshot.theme === 'grass') {
        const above = y > 0 ? Number(snapshot.grid[index - snapshot.width]) : Cell.Floor;
        const frame = hard
          ? TILE_FRAMES.hard
          : above === Cell.Hard
            ? TILE_FRAMES.shadow
            : TILE_FRAMES.grass;
        if (rebuild) {
          this.background.push(
            this.add
              .image(x * TILE_SIZE, y * TILE_SIZE, 'tiles', frame)
              .setOrigin(0, 0)
              .setDepth(0),
          );
        } else {
          this.background[index]!.setTexture('tiles', frame);
        }
      } else {
        const texture = tileKey(snapshot.theme, hard ? 'hard' : 'floor');
        if (rebuild) {
          this.background.push(
            this.add
              .image(x * TILE_SIZE, y * TILE_SIZE, texture)
              .setOrigin(0, 0)
              .setDepth(0),
          );
        } else {
          this.background[index]!.setTexture(texture);
        }
      }
    }
    this.arenaGrid = snapshot.grid;
  }

  private createThemeTextures(): void {
    const make = (key: string, draw: (graphics: Phaser.GameObjects.Graphics) => void) => {
      const graphics = this.make.graphics({ x: 0, y: 0 });
      draw(graphics);
      graphics.generateTexture(key, TILE_SIZE, TILE_SIZE);
      graphics.destroy();
    };
    make('cave-floor', (g) => {
      g.fillStyle(0x5a3d2b).fillRect(0, 0, 16, 16);
      g.fillStyle(0x694a34).fillRect(1, 2, 6, 2).fillRect(10, 10, 5, 2);
    });
    make('cave-hard', (g) => {
      g.fillStyle(0x342720).fillRect(0, 0, 16, 16);
      g.fillStyle(0x665347).fillCircle(5, 6, 5).fillCircle(12, 10, 5);
      g.fillStyle(0x806b5b).fillRect(3, 3, 4, 2).fillRect(9, 7, 4, 2);
    });
    make('cave-soft', (g) => {
      g.fillStyle(0x4b3428).fillRect(0, 0, 16, 16);
      g.fillStyle(0x93694d).fillCircle(5, 9, 5).fillCircle(11, 7, 5);
      g.fillStyle(0xb18464).fillRect(4, 5, 4, 2);
    });
    make('water-floor', (g) => {
      g.fillStyle(0x287fa3).fillRect(0, 0, 16, 16);
      g.fillStyle(0x4ca8c8).fillRect(1, 4, 7, 2).fillRect(9, 11, 6, 2);
    });
    make('water-hard', (g) => {
      g.fillStyle(0x1e566d).fillRect(0, 0, 16, 16);
      g.fillStyle(0x54747c).fillCircle(5, 7, 5).fillCircle(12, 10, 5);
      g.fillStyle(0x76959c).fillRect(3, 4, 4, 2);
    });
    make('water-soft', (g) => {
      g.fillStyle(0x5a341e).fillRect(2, 1, 12, 14);
      g.fillStyle(0xa96732).fillRect(4, 1, 8, 14);
      g.fillStyle(0xd18a49).fillRect(6, 2, 3, 12);
      g.fillStyle(0x35271f).fillRect(2, 3, 12, 2).fillRect(2, 11, 12, 2);
    });
  }

  private syncItems(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const item of snapshot.items) {
      const key = cellKey(item.x, item.y);
      seen.add(key);
      if (this.items.has(key)) continue;
      this.items.set(
        key,
        this.add
          .sprite(item.x * TILE_SIZE, item.y * TILE_SIZE, 'items', ITEM_SPRITE_FRAMES[item.type])
          .setOrigin(0, 0)
          .setDepth(1),
      );
    }
    for (const [key, sprite] of this.items) {
      if (!seen.has(key)) {
        sprite.destroy();
        this.items.delete(key);
      }
    }
  }

  private syncBombs(snapshot: Snapshot): void {
    const seen = new Set<number>();
    for (const bomb of snapshot.bombs) {
      seen.add(bomb.id);
      if (this.bombs.has(bomb.id)) continue;
      const appearance = this.appearanceOf(bomb.ownerId);
      const sprite = this.add
        .sprite(bomb.x * TILE_SIZE, bomb.y * TILE_SIZE, `${appearance}-bomb`, 0)
        .setOrigin(0, 0)
        .setDepth(2);
      sprite.play(`${appearance}-bomb-ticking`);
      this.bombs.set(bomb.id, { sprite, ownerId: bomb.ownerId });
    }
    for (const [id, entry] of this.bombs) {
      if (!seen.has(id)) {
        entry.sprite.destroy();
        this.bombs.delete(id);
      }
    }
  }

  private syncFlames(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const flame of snapshot.flames) {
      const key = cellKey(flame.x, flame.y);
      seen.add(key);
      const existing = this.flames.get(key);
      const appearance = this.appearanceOf(flame.ownerId);
      const animation = `${appearance}-flame-${FLAME_ANIMATIONS[flame.kind].name}`;
      if (existing) {
        if (existing.kind !== flame.kind || existing.appearance !== appearance) {
          existing.kind = flame.kind;
          existing.ownerId = flame.ownerId;
          existing.appearance = appearance;
          existing.sprite.setTexture(`${appearance}-flame`);
          existing.sprite.play(animation);
        }
        continue;
      }
      const sprite = this.add
        .sprite(flame.x * TILE_SIZE, flame.y * TILE_SIZE, `${appearance}-flame`, 5)
        .setOrigin(0, 0)
        .setDepth(3);
      sprite.play(animation);
      this.flames.set(key, {
        sprite,
        kind: flame.kind,
        ownerId: flame.ownerId,
        appearance,
      });
    }
    for (const [key, entry] of this.flames) {
      if (!seen.has(key)) {
        entry.sprite.destroy();
        this.flames.delete(key);
      }
    }
  }

  private syncPlayer(player: SnapshotPlayer, instant: boolean): void {
    const appearance = this.appearanceOf(player.id);
    const targetX = player.px * TILE_SIZE + TILE_SIZE / 2;
    const targetY = player.py * TILE_SIZE + TILE_SIZE / 2;
    let entry = this.players.get(player.id);
    if (!entry) {
      const sprite = this.add
        .sprite(targetX, targetY, `${appearance}-bm`, IDLE_FRAMES.down)
        .setOrigin(0.47, 0.7)
        .setDepth(10);
      entry = { sprite, targetX, targetY, alive: true, facing: player.facing, appearance };
      this.players.set(player.id, entry);
      if (!player.alive) {
        entry.alive = false;
        sprite.setVisible(false);
      }
    }
    entry.targetX = targetX;
    entry.targetY = targetY;
    entry.facing = player.facing;
    const { sprite } = entry;
    if (instant) {
      sprite.setPosition(targetX, targetY);
      sprite.setVisible(player.alive);
      sprite.setAlpha(1);
      entry.alive = player.alive;
    }
    if (!player.alive) {
      if (entry.alive) {
        entry.alive = false;
        sprite.play(`${entry.appearance}-death`);
        sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => sprite.setVisible(false));
      }
      return;
    }
    entry.alive = true;
    sprite.setVisible(true);
    if (player.moving) {
      sprite.play(`${entry.appearance}-${player.facing}`, true);
    } else {
      sprite.anims.stop();
      sprite.setFrame(IDLE_FRAMES[player.facing]);
    }
  }
}

/** Thin imperative wrapper so React components can mount a Phaser arena and feed it snapshots. */
export class ArenaRenderer {
  private readonly game: Phaser.Game;
  private readonly parent: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private scene: ArenaScene | null = null;
  private pending: { snapshot: Snapshot; instant: boolean } | null = null;
  private muted = true;
  private highlighted: readonly number[] = [];
  private playerSkins = new Map<number, SkinSlug>();
  private fitFrame = 0;

  constructor(parent: HTMLElement) {
    this.parent = parent;
    // Keep the box sized by CSS aspect-ratio only — Phaser's default expandParent
    // can pin height: 100% when the node is still 0×0, which leaves letterboxing
    // (and overflow:hidden cropping) once the board width changes.
    parent.style.aspectRatio = `${WIDTH} / ${HEIGHT}`;
    parent.style.removeProperty('height');
    const scene = new ArenaScene();
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: WIDTH,
      height: HEIGHT,
      pixelArt: true,
      backgroundColor: '#000000',
      banner: false,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        expandParent: false,
      },
      scene,
    });
    this.resizeObserver = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (!size || size.width <= 0 || size.height <= 0) return;
      this.game.scale.refresh();
    });
    this.resizeObserver.observe(parent);
    this.game.events.once(Phaser.Core.Events.READY, () => {
      this.scene = scene;
      scene.muted = this.muted;
      scene.setHighlighted(this.highlighted);
      scene.setPlayerSkins(this.playerSkins);
      if (this.pending) {
        scene.apply(this.pending.snapshot, this.pending.instant);
        this.pending = null;
      }
      this.fitToParent();
    });
  }

  push(snapshot: Snapshot, instant = false): void {
    const width = snapshot.width * TILE_SIZE;
    const height = snapshot.height * TILE_SIZE;
    this.parent.style.aspectRatio = `${width} / ${height}`;
    this.parent.style.removeProperty('height');
    if (this.game.scale.gameSize.width !== width || this.game.scale.gameSize.height !== height) {
      // setGameSize (not resize) keeps FIT mode in sync with the new board aspect.
      this.game.scale.setGameSize(width, height);
    }
    this.fitToParent();
    if (this.scene) this.scene.apply(snapshot, instant);
    else this.pending = { snapshot, instant };
  }

  /** Remeasure the parent after CSS aspect-ratio has been applied this frame. */
  private fitToParent(): void {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      this.game.scale.refresh();
    });
  }

  reset(snapshot?: Snapshot): void {
    this.scene?.clearAll();
    if (snapshot) this.push(snapshot, true);
  }

  /** Freezes the current frame; the next `push` brings the arena back to life. */
  halt(): void {
    this.scene?.halt();
  }

  setHighlighted(slots: readonly number[]): void {
    this.highlighted = slots;
    this.scene?.setHighlighted(slots);
  }

  setPlayerSkins(skins: ReadonlyMap<number, SkinSlug>): void {
    this.playerSkins = new Map(skins);
    this.scene?.setPlayerSkins(skins);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.scene) this.scene.muted = muted;
  }

  destroy(): void {
    cancelAnimationFrame(this.fitFrame);
    this.resizeObserver.disconnect();
    this.scene = null;
    this.pending = null;
    // Blur and focus would otherwise suspend or resume the AudioContext after it is closed.
    this.game.sound.pauseOnBlur = false;
    this.game.destroy(true);
  }
}
