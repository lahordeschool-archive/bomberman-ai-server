import Phaser from 'phaser';
import {
  Cell,
  type FlameKind,
  GRID_HEIGHT,
  GRID_WIDTH,
  isHardWallCell,
  ITEM_SPRITE_FRAMES,
  PLAYER_COLORS,
  type Snapshot,
  type SnapshotPlayer,
  TICK_MS,
  TILE_SIZE,
} from '@bomberman/game-engine';

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

interface PlayerSprite {
  sprite: Phaser.GameObjects.Sprite;
  targetX: number;
  targetY: number;
  alive: boolean;
}

class ArenaScene extends Phaser.Scene {
  private ready = false;
  private queued: { snapshot: Snapshot; instant: boolean } | null = null;
  private walls = new Map<number, Phaser.GameObjects.Sprite>();
  private items = new Map<string, Phaser.GameObjects.Sprite>();
  private bombs = new Map<number, Phaser.GameObjects.Sprite>();
  private flames = new Map<string, { sprite: Phaser.GameObjects.Sprite; kind: FlameKind }>();
  private players = new Map<number, PlayerSprite>();
  private markers = new Map<number, Phaser.GameObjects.Graphics>();
  private highlighted: readonly number[] = [];
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
      const walk = (key: string, start: number) =>
        this.anims.create({
          key: `${color}-${key}`,
          frames: this.anims.generateFrameNumbers(`${color}-bm`, { start, end: start + 2 }),
          frameRate: 8,
          repeat: -1,
        });
      walk('up', 0);
      walk('left', 3);
      walk('down', 6);
      walk('right', 9);
      this.anims.create({
        key: `${color}-death`,
        frames: this.anims.generateFrameNumbers(`${color}-bm`, { start: 12, end: 17 }),
        frameRate: 8,
        repeat: 0,
      });
      this.anims.create({
        key: `${color}-bomb-ticking`,
        frames: this.anims.generateFrameNumbers(`${color}-bomb`, { start: 0, end: 3 }),
        frameRate: 3,
        repeat: -1,
      });
      this.anims.create({
        key: `${color}-wall-destroyed`,
        frames: this.anims.generateFrameNumbers(`${color}-wall`, { start: 0, end: 5 }),
        frameRate: 12,
        repeat: 0,
      });
      for (const animation of Object.values(FLAME_ANIMATIONS)) {
        this.anims.create({
          key: `${color}-flame-${animation.name}`,
          frames: this.anims.generateFrameNumbers(`${color}-flame`, { frames: animation.frames }),
          frameRate: 18,
          repeat: -1,
        });
      }
    }

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const frame = isHardWallCell(x, y)
          ? TILE_FRAMES.hard
          : y > 0 && isHardWallCell(x, y - 1)
            ? TILE_FRAMES.shadow
            : TILE_FRAMES.grass;
        this.add
          .image(x * TILE_SIZE, y * TILE_SIZE, 'tiles', frame)
          .setOrigin(0, 0)
          .setDepth(0);
      }
    }
    this.ready = true;
    this.setHighlighted(this.highlighted);
    if (this.queued) {
      this.apply(this.queued.snapshot, this.queued.instant);
      this.queued = null;
    }
  }

  override update(time: number, delta: number): void {
    const factor = Math.min(1, delta / (TICK_MS * 1.5));
    for (const entry of this.players.values()) {
      const { sprite } = entry;
      sprite.x += (entry.targetX - sprite.x) * factor;
      sprite.y += (entry.targetY - sprite.y) * factor;
      sprite.setDepth(10 + sprite.y / HEIGHT);
    }
    const bob = Math.round(Math.sin(time / 180) * 1.5);
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

  clearAll(): void {
    for (const sprite of this.walls.values()) sprite.destroy();
    for (const sprite of this.items.values()) sprite.destroy();
    for (const sprite of this.bombs.values()) sprite.destroy();
    for (const { sprite } of this.flames.values()) sprite.destroy();
    for (const { sprite } of this.players.values()) sprite.destroy();
    this.walls.clear();
    this.items.clear();
    this.bombs.clear();
    this.flames.clear();
    this.players.clear();
  }

  apply(snapshot: Snapshot, instant: boolean): void {
    if (!this.ready) {
      this.queued = { snapshot, instant };
      return;
    }
    const wallOwners = new Map<number, number>();
    for (const event of snapshot.events) {
      if (event.type === 'wallDestroyed') wallOwners.set(event.y * GRID_WIDTH + event.x, event.by);
      if (event.type === 'bombExploded' && !instant && !this.muted) {
        this.sound.play('explosion', { volume: 0.25 });
      }
    }
    this.syncWalls(snapshot, wallOwners, instant);
    this.syncItems(snapshot);
    this.syncBombs(snapshot);
    this.syncFlames(snapshot);
    for (const player of snapshot.players) this.syncPlayer(player, instant);
  }

  private syncWalls(snapshot: Snapshot, owners: Map<number, number>, instant: boolean): void {
    for (let index = 0; index < snapshot.grid.length; index++) {
      const isSoft = Number(snapshot.grid[index]) === Cell.Soft;
      const sprite = this.walls.get(index);
      if (isSoft && !sprite) {
        const x = (index % GRID_WIDTH) * TILE_SIZE;
        const y = Math.floor(index / GRID_WIDTH) * TILE_SIZE;
        this.walls.set(
          index,
          this.add.sprite(x, y, 'tiles', TILE_FRAMES.soft).setOrigin(0, 0).setDepth(1),
        );
      } else if (!isSoft && sprite) {
        this.walls.delete(index);
        if (instant) {
          sprite.destroy();
        } else {
          sprite.play(`${colorOf(owners.get(index) ?? 0)}-wall-destroyed`);
          sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => sprite.destroy());
        }
      }
    }
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
      const sprite = this.add
        .sprite(bomb.x * TILE_SIZE, bomb.y * TILE_SIZE, `${colorOf(bomb.ownerId)}-bomb`, 0)
        .setOrigin(0, 0)
        .setDepth(2);
      sprite.play(`${colorOf(bomb.ownerId)}-bomb-ticking`);
      this.bombs.set(bomb.id, sprite);
    }
    for (const [id, sprite] of this.bombs) {
      if (!seen.has(id)) {
        sprite.destroy();
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
      const animation = `${colorOf(flame.ownerId)}-flame-${FLAME_ANIMATIONS[flame.kind].name}`;
      if (existing) {
        if (existing.kind !== flame.kind) {
          existing.kind = flame.kind;
          existing.sprite.play(animation);
        }
        continue;
      }
      const sprite = this.add
        .sprite(flame.x * TILE_SIZE, flame.y * TILE_SIZE, `${colorOf(flame.ownerId)}-flame`, 5)
        .setOrigin(0, 0)
        .setDepth(3);
      sprite.play(animation);
      this.flames.set(key, { sprite, kind: flame.kind });
    }
    for (const [key, entry] of this.flames) {
      if (!seen.has(key)) {
        entry.sprite.destroy();
        this.flames.delete(key);
      }
    }
  }

  private syncPlayer(player: SnapshotPlayer, instant: boolean): void {
    const color = colorOf(player.id);
    const targetX = player.px * TILE_SIZE + TILE_SIZE / 2;
    const targetY = player.py * TILE_SIZE + TILE_SIZE / 2;
    let entry = this.players.get(player.id);
    if (!entry) {
      const sprite = this.add
        .sprite(targetX, targetY, `${color}-bm`, IDLE_FRAMES.down)
        .setOrigin(0.47, 0.7)
        .setDepth(10);
      entry = { sprite, targetX, targetY, alive: true };
      this.players.set(player.id, entry);
      if (!player.alive) {
        entry.alive = false;
        sprite.setVisible(false);
      }
    }
    entry.targetX = targetX;
    entry.targetY = targetY;
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
        sprite.play(`${color}-death`);
        sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => sprite.setVisible(false));
      }
      return;
    }
    entry.alive = true;
    sprite.setVisible(true);
    if (player.moving) {
      sprite.play(`${color}-${player.facing}`, true);
    } else {
      sprite.anims.stop();
      sprite.setFrame(IDLE_FRAMES[player.facing]);
    }
  }
}

/** Thin imperative wrapper so React components can mount a Phaser arena and feed it snapshots. */
export class ArenaRenderer {
  private readonly game: Phaser.Game;
  private scene: ArenaScene | null = null;
  private pending: { snapshot: Snapshot; instant: boolean } | null = null;
  private muted = true;
  private highlighted: readonly number[] = [];

  constructor(parent: HTMLElement) {
    const scene = new ArenaScene();
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: WIDTH,
      height: HEIGHT,
      pixelArt: true,
      backgroundColor: '#000000',
      banner: false,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene,
    });
    this.game.events.once(Phaser.Core.Events.READY, () => {
      this.scene = scene;
      scene.muted = this.muted;
      scene.setHighlighted(this.highlighted);
      if (this.pending) {
        scene.apply(this.pending.snapshot, this.pending.instant);
        this.pending = null;
      }
    });
  }

  push(snapshot: Snapshot, instant = false): void {
    if (this.scene) this.scene.apply(snapshot, instant);
    else this.pending = { snapshot, instant };
  }

  reset(snapshot?: Snapshot): void {
    this.scene?.clearAll();
    if (snapshot) this.push(snapshot, true);
  }

  setHighlighted(slots: readonly number[]): void {
    this.highlighted = slots;
    this.scene?.setHighlighted(slots);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.scene) this.scene.muted = muted;
  }

  destroy(): void {
    this.scene = null;
    this.pending = null;
    // Blur and focus would otherwise suspend or resume the AudioContext after it is closed.
    this.game.sound.pauseOnBlur = false;
    this.game.destroy(true);
  }
}
