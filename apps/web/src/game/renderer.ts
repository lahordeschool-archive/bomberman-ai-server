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
} from '@bomberman/game-engine';
import type { SkinSlug } from '@bomberman/protocol';
import * as THREE from 'three';
import { assignPlayerColors, SLOT_COLOR_SWATCHES } from './player-colors.ts';

const VIEW_ASPECT = 16 / 10;
const ASSETS = '/game';
const WORLD_Y = 0.08;
const IDLE_FRAMES = { up: 1, left: 4, down: 7, right: 10 } as const;
const WALK_START = { up: 0, left: 3, down: 6, right: 9 } as const;

const SKIN_ACCENTS: Record<SkinSlug, string> = {
  ember: '#ff7018',
  moss: '#44a848',
  tide: '#18aed6',
  sunset: '#f46280',
  royal: '#8448d6',
  neon: '#1eebb0',
  frost: '#8edaff',
  shadow: '#665a80',
  galaxy: '#5654c8',
  crown: '#e6a41a',
};

const THEMES = {
  grass: {
    background: 0x101a14,
    fog: 0x101a14,
    floor: 0x6c9b52,
    floorAlt: 0x75a65a,
    hard: 0x789075,
    hardTop: 0x9bad94,
    soft: 0xb8783f,
    softDark: 0x6d3f27,
  },
  cave: {
    background: 0x171110,
    fog: 0x171110,
    floor: 0x594337,
    floorAlt: 0x624a3c,
    hard: 0x51443e,
    hardTop: 0x75645a,
    soft: 0x9b6848,
    softDark: 0x53372b,
  },
  water: {
    background: 0x071821,
    fog: 0x071821,
    floor: 0x247b9a,
    floorAlt: 0x2b89aa,
    hard: 0x537a82,
    hardTop: 0x78a1a7,
    soft: 0xaa6834,
    softDark: 0x583720,
  },
} as const;

interface PlayerVisual {
  root: THREE.Group;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  marker: THREE.Sprite;
  target: THREE.Vector3;
  appearance: string;
  facing: SnapshotPlayer['facing'];
  moving: boolean;
  alive: boolean;
  deathStarted: number | null;
}

interface BombVisual {
  root: THREE.Group;
  ownerId: number;
  phase: number;
}

interface FlameVisual {
  root: THREE.Group;
  ownerId: number;
  kind: FlameKind;
  phase: number;
}

interface FadingVisual {
  object: THREE.Object3D;
  started: number;
  duration: number;
  dropY?: number;
}

const colorOf = (playerId: number) => PLAYER_COLORS[playerId % PLAYER_COLORS.length]!;
const cellKey = (x: number, y: number) => `${x},${y}`;

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  for (const entry of Array.isArray(material) ? material : [material]) {
    const textured = entry as THREE.Material & { map?: THREE.Texture | null };
    textured.map?.dispose();
    entry.dispose();
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Sprite)) return;
    child.geometry?.dispose();
    disposeMaterial(child.material);
  });
}

/**
 * Lightweight isometric scene. Geometry and effects are generated in code; the only
 * image downloaded per player is that player's tiny existing skin sheet.
 */
class IsometricArena {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly loader = new THREE.TextureLoader();
  private readonly textureCache = new Map<string, Promise<THREE.Texture>>();
  private readonly staticRoot = new THREE.Group();
  private readonly dynamicRoot = new THREE.Group();
  private readonly hardWalls = new Map<number, THREE.Group>();
  private readonly softWalls = new Map<number, THREE.Group>();
  private readonly items = new Map<string, THREE.Sprite>();
  private readonly bombs = new Map<number, BombVisual>();
  private readonly flames = new Map<string, FlameVisual>();
  private readonly players = new Map<number, PlayerVisual>();
  private readonly warnings = new Map<string, THREE.Mesh>();
  private readonly fading: FadingVisual[] = [];
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private readonly parent: HTMLElement;
  private frame = 0;
  private width = GRID_WIDTH;
  private height = GRID_HEIGHT;
  private arenaKey = '';
  private grid = '';
  private muted = true;
  private halted = false;
  private visible = true;
  private highlighted: readonly number[] = [];
  private playerSkins = new Map<number, SkinSlug>();
  private closingAnnounced = false;
  private lastTime = 0;
  private audio: HTMLAudioElement | null = null;

  constructor(parent: HTMLElement) {
    this.parent = parent;
    this.scene.add(this.staticRoot, this.dynamicRoot);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    parent.replaceChildren(this.renderer.domElement);
    parent.style.aspectRatio = `${VIEW_ASPECT}`;

    const hemisphere = new THREE.HemisphereLight(0xd8efff, 0x172019, 2.25);
    const sun = new THREE.DirectionalLight(0xffefcf, 3.1);
    sun.position.set(-7, 13, 9);
    this.scene.add(hemisphere, sun);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(parent);
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry?.isIntersecting ?? true;
      if (this.visible) {
        this.clock.getDelta();
        this.scheduleFrame();
      }
    });
    this.visibilityObserver.observe(parent);
    this.resize();
    this.fitCamera();
    this.scheduleFrame();
  }

  private resize(): void {
    const { width, height } = this.parent.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(Math.round(width), Math.round(height), false);
    this.fitCamera();
  }

  private fitCamera(): void {
    const halfHeight = (this.width + this.height) * 0.18 + 1.8;
    const halfWidth = halfHeight * VIEW_ASPECT;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.near = 0.1;
    this.camera.far = 80;
    this.camera.position.set(12, 15, 14);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  private scheduleFrame(): void {
    if (!this.visible || this.frame) return;
    this.frame = requestAnimationFrame(this.animate);
  }

  private readonly animate = (): void => {
    this.frame = 0;
    if (!this.visible) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();
    this.lastTime = now;

    for (const player of this.players.values()) {
      const factor = Math.min(1, delta / (TICK_MS / 1000));
      player.root.position.lerp(player.target, factor);
      player.root.renderOrder = Math.round((player.root.position.z + this.height) * 10);
      if (!this.halted && player.alive) {
        const frame = player.moving
          ? WALK_START[player.facing] + (Math.floor(now / 125) % 3)
          : IDLE_FRAMES[player.facing];
        this.setAtlasFrame(player.material.map, frame, 18, 1);
        player.sprite.position.y = 0.76 + (player.moving ? Math.sin(now / 80) * 0.025 : 0);
        player.marker.position.y = 1.62 + Math.sin(now / 180) * 0.045;
      } else if (player.deathStarted !== null) {
        const progress = Math.min(1, (now - player.deathStarted) / 700);
        this.setAtlasFrame(player.material.map, 12 + Math.min(5, Math.floor(progress * 6)), 18, 1);
        player.material.opacity = 1 - Math.max(0, progress - 0.72) / 0.28;
        if (progress === 1) player.root.visible = false;
      }
    }

    if (!this.halted) {
      for (const bomb of this.bombs.values()) {
        const pulse = 1 + Math.sin(now / 105 + bomb.phase) * 0.08;
        bomb.root.scale.setScalar(pulse);
        bomb.root.rotation.y += delta * 0.7;
      }
      for (const flame of this.flames.values()) {
        const pulse = 0.88 + Math.sin(now / 48 + flame.phase) * 0.16;
        flame.root.scale.set(pulse, 0.9 + pulse * 0.2, pulse);
        flame.root.rotation.y += delta * 1.8;
      }
      for (const warning of this.warnings.values()) {
        const material = warning.material as THREE.MeshBasicMaterial;
        material.opacity = 0.16 + (Math.sin(now / 90) + 1) * 0.13;
      }
    }

    for (let index = this.fading.length - 1; index >= 0; index--) {
      const entry = this.fading[index]!;
      const progress = Math.min(1, (now - entry.started) / entry.duration);
      if (entry.dropY !== undefined) {
        entry.object.position.y = THREE.MathUtils.lerp(entry.dropY, WORLD_Y, progress ** 2);
      } else {
        entry.object.scale.setScalar(1 - progress * 0.72);
        entry.object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(child.material)
            ? child.material
            : [child.material]) {
            material.transparent = true;
            material.opacity = 1 - progress;
          }
        });
      }
      if (progress === 1) {
        entry.object.removeFromParent();
        disposeObject(entry.object);
        this.fading.splice(index, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.scheduleFrame();
  };

  private worldPosition(x: number, y: number, elevation = WORLD_Y): THREE.Vector3 {
    return new THREE.Vector3(x - this.width / 2 + 0.5, elevation, y - this.height / 2 + 0.5);
  }

  private material(color: THREE.ColorRepresentation, roughness = 0.78): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
  }

  private buildFloor(theme: Snapshot['theme']): void {
    const palette = THEMES[theme];
    const geometry = new THREE.BoxGeometry(0.98, 0.12, 0.98);
    const mesh = new THREE.InstancedMesh(
      geometry,
      this.material(0xffffff, 0.92),
      this.width * this.height,
    );
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let index = 0; index < this.width * this.height; index++) {
      const x = index % this.width;
      const y = Math.floor(index / this.width);
      matrix.makeTranslation(this.worldPosition(x, y, 0).x, 0, this.worldPosition(x, y, 0).z);
      mesh.setMatrixAt(index, matrix);
      color.setHex((x + y) % 2 ? palette.floor : palette.floorAlt);
      mesh.setColorAt(index, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    this.staticRoot.add(mesh);

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(this.width + 0.5, 0.36, this.height + 0.5),
      this.material(new THREE.Color(palette.floor).multiplyScalar(0.44), 1),
    );
    base.position.y = -0.23;
    this.staticRoot.add(base);
  }

  private createHardWall(theme: Snapshot['theme']): THREE.Group {
    const palette = THEMES[theme];
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.92, 0.82),
      this.material(palette.hard),
    );
    body.position.y = 0.52;
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.12, 0.68),
      this.material(palette.hardTop, 0.68),
    );
    top.position.y = 1.04;
    const shadow = this.createShadow(0.82);
    group.add(shadow, body, top);
    return group;
  }

  private createSoftWall(theme: Snapshot['theme']): THREE.Group {
    const palette = THEMES[theme];
    const group = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.7, 0.8),
      this.material(palette.soft, 0.86),
    );
    box.position.y = 0.42;
    const bandMaterial = this.material(palette.softDark, 0.9);
    const bandA = new THREE.Mesh(new THREE.BoxGeometry(0.89, 0.1, 0.13), bandMaterial);
    const bandB = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.89), bandMaterial);
    bandA.position.y = bandB.position.y = 0.8;
    group.add(this.createShadow(0.77), box, bandA, bandB);
    return group;
  }

  private createShadow(size: number): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(size / 2, 16), material);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0.08, 0.071, 0.11);
    return shadow;
  }

  private syncArena(snapshot: Snapshot): void {
    const key = `${snapshot.width}x${snapshot.height}:${snapshot.theme}`;
    if (key !== this.arenaKey) {
      this.clear();
      this.arenaKey = key;
      this.width = snapshot.width;
      this.height = snapshot.height;
      this.scene.background = new THREE.Color(THEMES[snapshot.theme].background);
      this.scene.fog = new THREE.Fog(THEMES[snapshot.theme].fog, 19, 38);
      this.buildFloor(snapshot.theme);
      this.fitCamera();
    }
    if (snapshot.grid === this.grid) return;

    for (let index = 0; index < snapshot.grid.length; index++) {
      const cell = Number(snapshot.grid[index]);
      const x = index % snapshot.width;
      const y = Math.floor(index / snapshot.width);
      const hard = this.hardWalls.get(index);
      if (cell === Cell.Hard && !hard) {
        const wall = this.createHardWall(snapshot.theme);
        wall.position.copy(this.worldPosition(x, y));
        this.staticRoot.add(wall);
        this.hardWalls.set(index, wall);
      } else if (cell !== Cell.Hard && hard) {
        hard.removeFromParent();
        disposeObject(hard);
        this.hardWalls.delete(index);
      }
    }
    this.grid = snapshot.grid;
  }

  private syncSoftWalls(snapshot: Snapshot, instant: boolean): void {
    for (let index = 0; index < snapshot.grid.length; index++) {
      const soft = Number(snapshot.grid[index]) === Cell.Soft;
      const existing = this.softWalls.get(index);
      if (soft && !existing) {
        const x = index % snapshot.width;
        const y = Math.floor(index / snapshot.width);
        const wall = this.createSoftWall(snapshot.theme);
        wall.position.copy(this.worldPosition(x, y));
        this.dynamicRoot.add(wall);
        this.softWalls.set(index, wall);
      } else if (!soft && existing) {
        this.softWalls.delete(index);
        if (instant) {
          existing.removeFromParent();
          disposeObject(existing);
        } else {
          this.fading.push({ object: existing, started: performance.now(), duration: 240 });
        }
      }
    }
  }

  private loadTexture(path: string): Promise<THREE.Texture> {
    let texture = this.textureCache.get(path);
    if (!texture) {
      texture = this.loader.loadAsync(path).then((loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.magFilter = THREE.NearestFilter;
        loaded.minFilter = THREE.NearestFilter;
        loaded.generateMipmaps = false;
        return loaded;
      });
      this.textureCache.set(path, texture);
    }
    return texture;
  }

  private appearancePath(playerId: number): string {
    const color = colorOf(playerId);
    const skin = this.playerSkins.get(playerId);
    return skin ? `${ASSETS}/skins/${skin}_${color}.png` : `${ASSETS}/sprites/snes_${color}.png`;
  }

  private appearanceOf(playerId: number): string {
    return `${this.playerSkins.get(playerId) ?? 'classic'}-${colorOf(playerId)}`;
  }

  private async updatePlayerTexture(playerId: number, visual: PlayerVisual): Promise<void> {
    const appearance = this.appearanceOf(playerId);
    visual.appearance = appearance;
    let source: THREE.Texture;
    try {
      source = await this.loadTexture(this.appearancePath(playerId));
    } catch {
      source = await this.loadTexture(`${ASSETS}/sprites/snes_${colorOf(playerId)}.png`);
    }
    if (visual.appearance !== appearance || !this.players.has(playerId)) return;
    const texture = source.clone();
    texture.needsUpdate = true;
    visual.material.map?.dispose();
    visual.material.map = texture;
    visual.material.needsUpdate = true;
    this.setAtlasFrame(texture, IDLE_FRAMES[visual.facing], 18, 1);
  }

  private setAtlasFrame(
    texture: THREE.Texture | null,
    frame: number,
    columns: number,
    rows: number,
  ): void {
    if (!texture) return;
    const column = frame % columns;
    const row = Math.floor(frame / columns);
    texture.repeat.set(1 / columns, 1 / rows);
    texture.offset.set(column / columns, 1 - (row + 1) / rows);
  }

  private makeMarker(playerId: number, own: boolean): THREE.Sprite {
    const colors = assignPlayerColors(
      [...this.players.keys(), playerId]
        .filter((value, index, all) => all.indexOf(value) === index)
        .map((slot) => ({ slot, skin: this.playerSkins.get(slot) })),
    );
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext('2d')!;
    context.shadowColor = '#000';
    context.shadowBlur = 5;
    context.fillStyle = colors.get(playerId) ?? '#ffffff';
    context.strokeStyle = '#080808';
    context.lineWidth = 4;
    if (own) {
      context.beginPath();
      context.moveTo(24, 38);
      context.lineTo(10, 12);
      context.lineTo(38, 12);
      context.closePath();
      context.fill();
      context.stroke();
    } else {
      context.beginPath();
      context.arc(24, 24, 10, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const marker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    marker.scale.setScalar(0.42);
    marker.renderOrder = 1000;
    return marker;
  }

  private refreshMarkers(): void {
    for (const [id, player] of this.players) {
      player.marker.removeFromParent();
      disposeObject(player.marker);
      player.marker = this.makeMarker(id, this.highlighted.includes(id));
      player.marker.position.y = 1.62;
      player.root.add(player.marker);
    }
  }

  private syncPlayers(snapshot: Snapshot, instant: boolean): void {
    const seen = new Set<number>();
    for (const player of snapshot.players) {
      seen.add(player.id);
      const position = this.worldPosition(player.px, player.py);
      let visual = this.players.get(player.id);
      if (!visual) {
        const material = new THREE.SpriteMaterial({
          transparent: true,
          alphaTest: 0.2,
          depthWrite: false,
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(0.82, 1.25, 1);
        sprite.position.y = 0.76;
        const root = new THREE.Group();
        root.position.copy(position);
        root.add(this.createShadow(0.62), sprite);
        const marker = this.makeMarker(player.id, this.highlighted.includes(player.id));
        marker.position.y = 1.62;
        root.add(marker);
        visual = {
          root,
          sprite,
          material,
          marker,
          target: position.clone(),
          appearance: '',
          facing: player.facing,
          moving: player.moving,
          alive: player.alive,
          deathStarted: player.alive ? null : performance.now(),
        };
        this.players.set(player.id, visual);
        this.dynamicRoot.add(root);
        void this.updatePlayerTexture(player.id, visual);
        this.refreshMarkers();
      }
      visual.target.copy(position);
      visual.facing = player.facing;
      visual.moving = player.moving;
      if (instant) visual.root.position.copy(position);
      if (!player.alive && visual.alive) {
        visual.alive = false;
        visual.deathStarted = performance.now();
      } else if (player.alive) {
        visual.alive = true;
        visual.deathStarted = null;
        visual.root.visible = true;
        visual.material.opacity = 1;
      }
    }
    for (const [id, visual] of this.players) {
      if (seen.has(id)) continue;
      visual.root.removeFromParent();
      disposeObject(visual.root);
      this.players.delete(id);
    }
  }

  private createBomb(ownerId: number): BombVisual {
    const skin = this.playerSkins.get(ownerId);
    const accent = skin ? SKIN_ACCENTS[skin] : SLOT_COLOR_SWATCHES[colorOf(ownerId)];
    const root = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.31, 2),
      new THREE.MeshStandardMaterial({
        color: 0x171820,
        roughness: 0.35,
        metalness: 0.45,
      }),
    );
    body.position.y = 0.38;
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.12, 0.12, 8),
      this.material(accent, 0.36),
    );
    cap.position.y = 0.68;
    const fuse = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.2, 6),
      new THREE.MeshBasicMaterial({ color: 0xffc24c }),
    );
    fuse.position.set(0.06, 0.8, 0);
    fuse.rotation.z = -0.35;
    root.add(this.createShadow(0.66), body, cap, fuse);
    return { root, ownerId, phase: Math.random() * Math.PI * 2 };
  }

  private syncBombs(snapshot: Snapshot): void {
    const seen = new Set<number>();
    for (const bomb of snapshot.bombs) {
      seen.add(bomb.id);
      if (this.bombs.has(bomb.id)) continue;
      const visual = this.createBomb(bomb.ownerId);
      visual.root.position.copy(this.worldPosition(bomb.x, bomb.y));
      this.dynamicRoot.add(visual.root);
      this.bombs.set(bomb.id, visual);
    }
    for (const [id, visual] of this.bombs) {
      if (seen.has(id)) continue;
      visual.root.removeFromParent();
      disposeObject(visual.root);
      this.bombs.delete(id);
    }
  }

  private createFlame(kind: FlameKind, ownerId: number): FlameVisual {
    const skin = this.playerSkins.get(ownerId);
    const accent = skin ? SKIN_ACCENTS[skin] : SLOT_COLOR_SWATCHES[colorOf(ownerId)];
    const root = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.36, 1), material);
    core.position.y = 0.43;
    core.scale.y = 1.35;
    root.add(core);
    const horizontal = kind === 'horizontal' || kind === 'endLeft' || kind === 'endRight';
    const vertical = kind === 'vertical' || kind === 'endUp' || kind === 'endDown';
    if (horizontal || vertical) {
      const beam = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 3, 8), material.clone());
      beam.position.y = 0.39;
      beam.rotation.z = Math.PI / 2;
      beam.rotation.y = vertical ? Math.PI / 2 : 0;
      root.add(beam);
    }
    return { root, ownerId, kind, phase: Math.random() * Math.PI * 2 };
  }

  private syncFlames(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const flame of snapshot.flames) {
      const key = cellKey(flame.x, flame.y);
      seen.add(key);
      const current = this.flames.get(key);
      if (current && current.kind === flame.kind && current.ownerId === flame.ownerId) continue;
      if (current) {
        current.root.removeFromParent();
        disposeObject(current.root);
      }
      const visual = this.createFlame(flame.kind, flame.ownerId);
      visual.root.position.copy(this.worldPosition(flame.x, flame.y));
      this.dynamicRoot.add(visual.root);
      this.flames.set(key, visual);
    }
    for (const [key, visual] of this.flames) {
      if (seen.has(key)) continue;
      visual.root.removeFromParent();
      disposeObject(visual.root);
      this.flames.delete(key);
    }
  }

  private async makeItem(frame: number): Promise<THREE.Sprite> {
    const source = await this.loadTexture(`${ASSETS}/sprites/snes_items.png`);
    const texture = source.clone();
    texture.needsUpdate = true;
    this.setAtlasFrame(texture, frame, 8, 8);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.2,
        depthWrite: false,
      }),
    );
    sprite.scale.setScalar(0.64);
    return sprite;
  }

  private syncItems(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const item of snapshot.items) {
      const key = cellKey(item.x, item.y);
      seen.add(key);
      if (this.items.has(key)) continue;
      // Reserve the key before loading so rapid snapshots cannot duplicate it.
      const placeholder = new THREE.Sprite();
      this.items.set(key, placeholder);
      void this.makeItem(ITEM_SPRITE_FRAMES[item.type]).then((sprite) => {
        if (this.items.get(key) !== placeholder) {
          disposeObject(sprite);
          return;
        }
        sprite.position.copy(this.worldPosition(item.x, item.y, 0.45));
        this.items.set(key, sprite);
        this.dynamicRoot.add(sprite);
      });
    }
    for (const [key, sprite] of this.items) {
      if (seen.has(key)) continue;
      sprite.removeFromParent();
      disposeObject(sprite);
      this.items.delete(key);
    }
  }

  private syncClosing(snapshot: Snapshot, instant: boolean): void {
    const seen = new Set<string>();
    for (const tile of snapshot.closing) {
      const key = cellKey(tile.x, tile.y);
      seen.add(key);
      if (this.warnings.has(key)) continue;
      const warning = new THREE.Mesh(
        new THREE.PlaneGeometry(0.92, 0.92),
        new THREE.MeshBasicMaterial({
          color: 0xff392e,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
        }),
      );
      warning.rotation.x = -Math.PI / 2;
      warning.position.copy(this.worldPosition(tile.x, tile.y, 0.075));
      this.dynamicRoot.add(warning);
      this.warnings.set(key, warning);
    }
    for (const [key, warning] of this.warnings) {
      if (seen.has(key)) continue;
      warning.removeFromParent();
      disposeObject(warning);
      this.warnings.delete(key);
    }
    const active = snapshot.closing.length > 0;
    if (active && !this.closingAnnounced && !instant) this.showBanner('HURRY UP!');
    this.closingAnnounced = active;
  }

  private showBanner(text: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.font = '900 64px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 12;
    context.strokeStyle = '#7d1018';
    context.strokeText(text, 256, 64);
    context.fillStyle = '#ffd84a';
    context.fillText(text, 256, 64);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
      }),
    );
    sprite.scale.set(6.4, 1.6, 1);
    sprite.position.set(0, 4, 0);
    sprite.renderOrder = 2000;
    this.scene.add(sprite);
    this.fading.push({ object: sprite, started: performance.now() + 800, duration: 700 });
  }

  private dropBlock(snapshot: Snapshot, x: number, y: number): void {
    const block = this.createHardWall(snapshot.theme);
    block.position.copy(this.worldPosition(x, y, 7));
    this.dynamicRoot.add(block);
    this.fading.push({ object: block, started: performance.now(), duration: 190, dropY: 7 });
  }

  apply(snapshot: Snapshot, instant: boolean): void {
    this.halted = false;
    this.syncArena(snapshot);
    this.syncSoftWalls(snapshot, instant);
    this.syncItems(snapshot);
    this.syncBombs(snapshot);
    this.syncFlames(snapshot);
    this.syncClosing(snapshot, instant);
    this.syncPlayers(snapshot, instant);
    for (const event of snapshot.events) {
      if (event.type === 'bombExploded' && !instant && !this.muted) this.playExplosion();
      if (event.type === 'tileClosed' && !instant) this.dropBlock(snapshot, event.x, event.y);
    }
    if (snapshot.status === 'finished') this.halt();
  }

  private playExplosion(): void {
    this.audio ??= new Audio(`${ASSETS}/audio/explosion.mp3`);
    this.audio.volume = 0.22;
    this.audio.currentTime = 0;
    void this.audio.play().catch(() => undefined);
  }

  setHighlighted(slots: readonly number[]): void {
    this.highlighted = slots;
    this.refreshMarkers();
  }

  setPlayerSkins(skins: ReadonlyMap<number, SkinSlug>): void {
    this.playerSkins = new Map(skins);
    for (const [id, player] of this.players) {
      const appearance = this.appearanceOf(id);
      if (appearance !== player.appearance) void this.updatePlayerTexture(id, player);
    }
    this.refreshMarkers();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  halt(): void {
    this.halted = true;
  }

  clear(): void {
    for (const child of [...this.staticRoot.children, ...this.dynamicRoot.children]) {
      child.removeFromParent();
      disposeObject(child);
    }
    for (const entry of this.fading) {
      entry.object.removeFromParent();
      disposeObject(entry.object);
    }
    this.hardWalls.clear();
    this.softWalls.clear();
    this.items.clear();
    this.bombs.clear();
    this.flames.clear();
    this.players.clear();
    this.warnings.clear();
    this.fading.length = 0;
    this.grid = '';
    this.closingAnnounced = false;
    this.halted = false;
  }

  reset(snapshot?: Snapshot): void {
    this.clear();
    this.arenaKey = '';
    if (snapshot) this.apply(snapshot, true);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.clear();
    for (const promise of this.textureCache.values()) {
      void promise.then((texture) => texture.dispose());
    }
    this.textureCache.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.audio?.pause();
  }
}

/** Imperative adapter retained for live matches, local games, and replay playback. */
export class ArenaRenderer {
  private readonly arena: IsometricArena;

  constructor(parent: HTMLElement) {
    this.arena = new IsometricArena(parent);
  }

  push(snapshot: Snapshot, instant = false): void {
    this.arena.apply(snapshot, instant);
  }

  reset(snapshot?: Snapshot): void {
    this.arena.reset(snapshot);
  }

  halt(): void {
    this.arena.halt();
  }

  setHighlighted(slots: readonly number[]): void {
    this.arena.setHighlighted(slots);
  }

  setPlayerSkins(skins: ReadonlyMap<number, SkinSlug>): void {
    this.arena.setPlayerSkins(skins);
  }

  setMuted(muted: boolean): void {
    this.arena.setMuted(muted);
  }

  destroy(): void {
    this.arena.destroy();
  }
}
