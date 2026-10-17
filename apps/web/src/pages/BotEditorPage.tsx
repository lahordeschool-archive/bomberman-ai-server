import {
  DECISION_BUDGET_MS,
  getSampleBot,
  randomSampleBots,
  SAMPLE_BOTS,
  STARTER_SOURCE,
  type BotLogLine,
} from '@bomberman/bot-sdk';
import { DEFAULT_MAX_TICKS } from '@bomberman/game-engine';
import type { BotDetail, BotSummary, RankedStatus, SkinSlug, SkinStore } from '@bomberman/protocol';
import {
  ArrowCounterClockwise,
  ArrowsIn,
  ArrowsOut,
  CloudArrowUp,
  Code,
  Coins,
  Globe,
  PencilSimple,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  Stop,
  Trophy,
  TShirt,
} from '@phosphor-icons/react';
import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type ConsoleLine, ConsolePanel } from '../components/ConsolePanel.tsx';
import {
  Button,
  Card,
  ErrorMessage,
  Field,
  formatDate,
  formatRating,
  Skeleton,
} from '../components/ui.tsx';
import { tvPath } from '../components/MatchList.tsx';
import { Modal } from '../components/Modal.tsx';
import type { WorkerBotEvents } from '../bots/worker-bot.ts';
import { ArenaCanvas } from '../game/ArenaCanvas.tsx';
import type { ArenaRenderer } from '../game/renderer.ts';
import { Scoreboard } from '../game/Scoreboard.tsx';
import { useCasualRoom } from '../game/useCasualRoom.ts';
import { useLocalMatch } from '../game/useLocalMatch.ts';
import { api } from '../lib/api.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

const CodeEditor = lazy(() => import('../components/CodeEditor.tsx'));
const RANDOM = 'random';
const STARTER = 'starter';

/** A saved version of one of your bots, usable as editor content or as an opponent. */
interface SavedCode {
  key: string;
  botId: string;
  versionId: string;
  label: string;
  skin: SkinSlug | null;
}

const savedKey = (botId: string, versionId: string) => `v:${botId}:${versionId}`;
const versionName = (version: { version: number; label: string | null }) => {
  const fallback = `v${version.version}`;
  if (!version.label || version.label === fallback) return fallback;
  return `${fallback} · ${version.label}`;
};
const isSaved = (key: string) => key.startsWith('v:');

/** Replaces each random seat with a distinct house bot when possible. */
function drawOpponents(slugs: readonly string[]): string[] {
  const pool = randomSampleBots(SAMPLE_BOTS.length)
    .map((sample) => sample.slug)
    .filter((slug) => !slugs.includes(slug));
  return slugs.map((slug) =>
    slug === RANDOM ? (pool.shift() ?? randomSampleBots(1)[0]!.slug) : slug,
  );
}
const MAX_CONSOLE_LINES = 300;
const EXPANDED_KEY = 'bomber:editor-expanded';

type Panel = 'online' | 'ranked';
type ConfigTab = 'code' | 'skins' | 'play';

function draftKey(botId: string) {
  return `bomber:draft:${botId}`;
}

function loadedCodeKey(botId: string) {
  return `bomber:loaded-code:${botId}`;
}

export default function BotEditorPage({ botId }: { botId: string }) {
  const { navigate } = useRouter();
  const { user } = useSession();
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [otherBots, setOtherBots] = useState<BotSummary[]>([]);
  const [savedSources, setSavedSources] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const [muted, setMuted] = useState(true);
  const [panel, setPanel] = useState<Panel>('ranked');
  const [configTab, setConfigTab] = useState<ConfigTab>('code');
  const [opponents, setOpponents] = useState<string[]>([RANDOM, RANDOM, RANDOM]);
  const [drawn, setDrawn] = useState<string[] | null>(null);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [submitting, setSubmitting] = useState(false);
  /** Name typed in the save dialog; null while the dialog is closed. */
  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Option of the code dropdown last loaded into the editor; defaults to the active version. */
  const [loadedKey, setLoadedKey] = useState(() => localStorage.getItem(loadedCodeKey(botId)));
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ranked, setRanked] = useState<RankedStatus | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [store, setStore] = useState<SkinStore | null>(null);
  const [buyingSkin, setBuyingSkin] = useState<SkinSlug | null>(null);
  const [rankedOnSave, setRankedOnSave] = useState(true);
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPANDED_KEY) === '1');
  const lineId = useRef(0);
  const sourceRef = useRef('');
  sourceRef.current = source ?? '';

  const log = useCallback((level: ConsoleLine['level'], message: string, tick?: number) => {
    setLines((current) =>
      [...current, { id: lineId.current++, level, message, tick }].slice(-MAX_CONSOLE_LINES),
    );
  }, []);

  const botEvents = useMemo<WorkerBotEvents>(
    () => ({
      onLogs: (logs: BotLogLine[], { tick }) => {
        for (const line of logs) log(line.level, line.message, tick);
      },
      onError: (message, { tick }) => log('error', message, tick),
      onSlow: (ms, { tick }) =>
        log(
          'warn',
          `gameLoop ran ${Math.round(ms)} ms of synchronous code. Ranked bots get 100 ms of CPU per run on a slower runtime.`,
          tick,
        ),
      onLate: (ms, { tick }) =>
        log(
          'warn',
          ms === null
            ? `No decision before the next turn: turns are being skipped. Answer within ${DECISION_BUDGET_MS} ms (less once you pick up roller skates), and keep slow requests in the background.`
            : `Decision took ${Math.round(ms)} ms, longer than your turn: that turn was skipped.`,
          tick,
        ),
    }),
    [log],
  );

  const local = useLocalMatch(renderer);
  const casual = useCasualRoom(renderer, () => sourceRef.current, botEvents);

  const layoutRef = useRef<HTMLDivElement>(null);
  const editorReady = source !== null;
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || !editorReady) return;
    /** Side by side, the editor ends level with the bottom of the scoreboard. */
    const fit = () => {
      const editor = layout.querySelector<HTMLElement>('.code-editor');
      const scoreboard = layout.querySelector<HTMLElement>('.arena-column .scoreboard');
      const sideBySide = getComputedStyle(layout).gridTemplateColumns.split(' ').length > 1;
      if (!editor || !scoreboard || !sideBySide) {
        layout.style.removeProperty('--editor-height');
        return;
      }
      const height = scoreboard.getBoundingClientRect().bottom - editor.getBoundingClientRect().top;
      layout.style.setProperty('--editor-height', `${Math.max(320, Math.round(height))}px`);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(layout);
    for (const column of layout.children) observer.observe(column);
    const frame = requestAnimationFrame(fit);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [editorReady, expanded]);

  useEffect(() => {
    if (local.error) log('error', local.error);
  }, [local.error, log]);
  useEffect(() => {
    if (casual.error) log('error', casual.error);
  }, [casual.error, log]);

  const refresh = useCallback(async () => {
    const detail = await api.bot(botId);
    setBot(detail);
    let active: string | null = null;
    if (detail.activeVersion) {
      active = (await api.version(botId, detail.activeVersion.id)).source;
      setActiveSource(active);
      if (active !== null) {
        const key = savedKey(botId, detail.activeVersion.id);
        setSavedSources((current) => ({ ...current, [key]: active! }));
      }
    }
    return { detail, active };
  }, [botId]);

  useEffect(() => {
    api.myBots().then(
      ({ bots }) => setOtherBots(bots.filter((other) => other.id !== botId && other.activeVersion)),
      () => undefined,
    );
  }, [botId]);

  const savedCode = useMemo<{ own: SavedCode[]; others: SavedCode[] }>(
    () => ({
      own: (bot?.versions ?? []).map((version) => ({
        key: savedKey(botId, version.id),
        botId,
        versionId: version.id,
        label: `${versionName(version)}${version.id === bot!.activeVersion?.id ? ' (active)' : ''}`,
        skin: bot?.skin ?? null,
      })),
      others: otherBots.map((other) => ({
        key: savedKey(other.id, other.activeVersion!.id),
        botId: other.id,
        versionId: other.activeVersion!.id,
        label: `${other.name}: ${versionName(other.activeVersion!)}`,
        skin: other.skin,
      })),
    }),
    [bot, botId, otherBots],
  );
  const selectedCode = useMemo(() => {
    const available = new Set([
      STARTER,
      ...SAMPLE_BOTS.map((sample) => sample.slug),
      ...savedCode.own.map((entry) => entry.key),
      ...savedCode.others.map((entry) => entry.key),
    ]);
    if (loadedKey && available.has(loadedKey)) return loadedKey;
    return bot?.activeVersion ? savedKey(botId, bot.activeVersion.id) : STARTER;
  }, [bot, botId, loadedKey, savedCode]);
  const findSaved = useCallback(
    (key: string) => [...savedCode.own, ...savedCode.others].find((entry) => entry.key === key),
    [savedCode],
  );

  /** Fetches (once) the source of saved versions; returns the updated cache. */
  const fetchSaved = useCallback(
    async (keys: readonly string[]) => {
      const cache = { ...savedSources };
      await Promise.all(
        keys
          .filter((key) => isSaved(key) && cache[key] === undefined)
          .map(async (key) => {
            const entry = findSaved(key);
            if (!entry) return;
            const version = await api.version(entry.botId, entry.versionId);
            if (version.source !== null) cache[key] = version.source;
          }),
      );
      setSavedSources(cache);
      return cache;
    },
    [savedSources, findSaved],
  );

  useEffect(() => {
    refresh()
      .then(({ active }) => {
        setSource(
          (current) => current ?? localStorage.getItem(draftKey(botId)) ?? active ?? STARTER_SOURCE,
        );
      })
      .catch((failure: Error) => setLoadError(failure.message));
    api.rankedStatus().then(setRanked, () => undefined);
    api.skinStore().then(setStore, () => undefined);
  }, [botId, refresh]);

  useEffect(() => {
    if (source !== null) localStorage.setItem(draftKey(botId), source);
  }, [botId, source]);

  useEffect(() => {
    if (panel !== 'ranked') return;
    const timer = setInterval(() => api.rankedStatus().then(setRanked, () => undefined), 4000);
    return () => clearInterval(timer);
  }, [panel]);

  useEffect(() => renderer?.setMuted(muted), [renderer, muted]);
  useEffect(() => {
    if (expanded) localStorage.setItem(EXPANDED_KEY, '1');
    else localStorage.removeItem(EXPANDED_KEY);
  }, [expanded]);
  const ownSlot = casual.match ? casual.match.slot : 0;
  useEffect(() => renderer?.setHighlighted([ownSlot]), [renderer, ownSlot]);

  const buildParticipants = useCallback(
    (slugs: readonly string[], cache: Record<string, string> = savedSources) => {
      const list = [
        {
          name: bot?.name ?? 'Your bot',
          source: source ?? '',
          detail: 'Draft',
          events: botEvents,
          skin: bot?.skin,
        },
      ];
      for (const slug of slugs) {
        if (slug === RANDOM) {
          list.push({
            name: 'Random house bot',
            source: '',
            detail: 'Drawn at start',
            events: {},
            skin: null,
          });
        } else if (isSaved(slug)) {
          const entry = findSaved(slug);
          if (entry) {
            list.push({
              name: entry.label.replace(' (active)', ''),
              source: cache[slug] ?? '',
              detail: 'Saved version',
              events: {},
              skin: entry.skin,
            });
          }
        } else {
          const sample = SAMPLE_BOTS.find((candidate) => candidate.slug === slug);
          if (sample)
            list.push({
              name: sample.name,
              source: sample.source,
              detail: 'Sample bot',
              events: {},
              skin: null,
            });
        }
      }
      return list;
    },
    [bot, source, savedSources, findSaved, botEvents],
  );
  const participants = useMemo(
    () => buildParticipants(drawn ?? opponents),
    [buildParticipants, drawn, opponents],
  );
  const playerSkins = JSON.stringify(
    (casual.match?.init.participants ?? participants).flatMap((participant, slot) =>
      participant.skin ? [['slot' in participant ? participant.slot : slot, participant.skin]] : [],
    ),
  );
  useEffect(() => {
    renderer?.setPlayerSkins(new Map(JSON.parse(playerSkins) as [number, SkinSlug][]));
  }, [renderer, playerSkins]);

  async function runTest() {
    casual.leave();
    const lineup = drawOpponents(opponents);
    let cache: Record<string, string>;
    try {
      cache = await fetchSaved(lineup);
    } catch (failure) {
      log('error', `Could not load a saved opponent: ${(failure as Error).message}`);
      return;
    }
    const players = buildParticipants(lineup, cache);
    log(
      'system',
      `Starting a local match against ${players
        .slice(1)
        .map((p) => p.name)
        .join(', ')}.`,
    );
    setDrawn(lineup);
    void local.start(players);
  }

  /** Replaces the editor content, asking first when it would discard unsaved work. */
  function replaceSource(next: string, label: string): boolean {
    if (next === source) return false;
    const knownCode = new Set([STARTER_SOURCE, ...Object.values(savedSources)]);
    if (activeSource) knownCode.add(activeSource);
    const unsaved = source !== null && !knownCode.has(source);
    if (
      unsaved &&
      !window.confirm(
        `Replace the editor content with ${label}? Your unsaved draft will be lost; saved versions are kept.`,
      )
    ) {
      return false;
    }
    setSource(next);
    return true;
  }

  function rememberLoaded(key: string) {
    setLoadedKey(key);
    localStorage.setItem(loadedCodeKey(botId), key);
  }

  async function loadCode(key: string) {
    setActionError(null);
    if (isSaved(key)) {
      const entry = findSaved(key);
      if (!entry) return;
      try {
        const cache = await fetchSaved([key]);
        if (cache[key] !== undefined && replaceSource(cache[key], entry.label)) {
          rememberLoaded(key);
          log('system', `Loaded ${entry.label} into the editor.`);
        }
      } catch (failure) {
        setActionError((failure as Error).message);
      }
      return;
    }
    const template =
      key === STARTER ? { name: 'Starter', source: STARTER_SOURCE } : getSampleBot(key);
    if (template && replaceSource(template.source, `the ${template.name} template`)) {
      rememberLoaded(key);
      log('system', `Loaded the ${template.name} template. Save a version to use it in ranked.`);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const label = saveLabel?.trim() ?? '';
    if (!source || !label) return;
    setSubmitting(true);
    setSaveError(null);
    setActionError(null);
    setNotice(null);
    try {
      const version = await api.submitVersion(botId, {
        source,
        visibility,
        label,
        ranked: rankedOnSave,
      });
      await refresh();
      rememberLoaded(savedKey(botId, version.id));
      setSaveLabel(null);
      setNotice(
        `Saved “${label}” as version ${version.version}.${
          rankedOnSave ? ' Your bot is queued for ranked play.' : ''
        }`,
      );
    } catch (failure) {
      setSaveError((failure as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleQueue() {
    setActionError(null);
    try {
      const next = bot?.queued ? await api.dequeue(botId) : await api.enqueue(botId);
      setRanked(next);
      await refresh();
    } catch (failure) {
      setActionError((failure as Error).message);
    }
  }

  async function equipSkin(skin: SkinSlug | null) {
    setActionError(null);
    try {
      setBot(await api.equipSkin(botId, skin));
    } catch (failure) {
      setActionError((failure as Error).message);
    }
  }

  async function buySkin(skin: SkinSlug) {
    setBuyingSkin(skin);
    setActionError(null);
    try {
      setStore(await api.purchaseSkin(skin));
      setBot(await api.equipSkin(botId, skin));
    } catch (failure) {
      setActionError((failure as Error).message);
    } finally {
      setBuyingSkin(null);
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    const name = renaming?.trim() ?? '';
    if (name.length < 2) {
      setActionError('Give your bot a name of at least 2 characters.');
      return;
    }
    setActionError(null);
    try {
      if (name !== bot?.name) setBot(await api.renameBot(botId, name));
      setRenaming(null);
    } catch (failure) {
      setActionError((failure as Error).message);
    }
  }

  async function deleteBot() {
    if (!window.confirm(`Delete ${bot?.name}? This cannot be undone.`)) return;
    try {
      await api.deleteBot(botId);
      localStorage.removeItem(draftKey(botId));
      localStorage.removeItem(loadedCodeKey(botId));
      navigate('/bots');
    } catch (failure) {
      setActionError((failure as Error).message);
    }
  }

  if (loadError) {
    return (
      <div className="page">
        <ErrorMessage>{loadError}</ErrorMessage>
        <Link to="/bots">Back to your bots</Link>
      </div>
    );
  }

  const onlineSnapshot = casual.match ? casual.snapshot : null;
  const snapshot = onlineSnapshot ?? local.snapshot;
  const scoreEntries = casual.match
    ? casual.match.init.participants.map((participant) => ({
        slot: participant.slot,
        name: participant.name,
        detail: participant.owner,
        skin: participant.skin,
      }))
    : participants.map((participant, slot) => ({
        slot,
        name: participant.name,
        detail: participant.detail,
        skin: participant.skin,
      }));
  const running = local.status === 'loading' || local.status === 'running';
  const isHost = casual.lobby?.hostUserId === user?.id;

  return (
    <div className={expanded ? 'editor-page is-expanded' : 'editor-page'}>
      <header className="editor-header">
        <div>
          <Link to="/bots" className="muted">
            My bots
          </Link>
          {renaming !== null ? (
            <form className="rename-form" onSubmit={rename}>
              <input
                aria-label="Bot name"
                value={renaming}
                maxLength={32}
                autoFocus
                onChange={(event) => setRenaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(null);
                }}
              />
              <Button type="submit" variant="primary">
                Save
              </Button>
              <Button onClick={() => setRenaming(null)}>Cancel</Button>
            </form>
          ) : (
            <h1 className="editor-title">
              {bot?.name ?? 'Loading bot'}
              {bot ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Rename bot"
                  title="Rename bot"
                  onClick={() => setRenaming(bot.name)}
                >
                  <PencilSimple />
                </button>
              ) : null}
            </h1>
          )}
        </div>
      </header>

      <div className="tabs editor-main-tabs" role="tablist" aria-label="Bot configuration">
        {(
          [
            ['code', 'Code', <Code key="code" />],
            ['skins', 'Skins', <TShirt key="skins" />],
            ['play', 'Play', <Play key="play" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={configTab === id}
            className="tab"
            onClick={() => setConfigTab(id)}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      <div className="editor-layout editor-tab-content" ref={layoutRef}>
        <div className="editor-column" hidden={configTab !== 'code'}>
          <div className="editor-toolbar">
            <Button
              variant="primary"
              className="button-icon"
              icon={running ? <ArrowCounterClockwise /> : <Play weight="fill" />}
              onClick={runTest}
              disabled={source === null}
              aria-label={running ? 'Restart test' : 'Run test'}
              title={running ? 'Restart the local test' : 'Run a local test'}
            />
            <Button
              className="button-icon"
              icon={<Stop />}
              onClick={local.stop}
              disabled={!running}
              aria-label="Stop"
              title="Stop the local test"
            />
            <select
              className="template-select"
              aria-label="Load code"
              title="Code loaded in the editor"
              value={selectedCode}
              disabled={source === null}
              onChange={(event) => void loadCode(event.target.value)}
            >
              <optgroup label="Templates">
                <option value={STARTER}>Starter: minimal random mover</option>
                {SAMPLE_BOTS.map((sample) => (
                  <option key={sample.slug} value={sample.slug} title={sample.description}>
                    {sample.name}: {sample.description}
                  </option>
                ))}
              </optgroup>
              {savedCode.own.length > 0 ? (
                <optgroup label="Saved versions of this bot">
                  {savedCode.own.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {savedCode.others.length > 0 ? (
                <optgroup label="Your other bots">
                  {savedCode.others.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            <span className="toolbar-spacer" />
            <Button
              className="button-icon"
              icon={<CloudArrowUp />}
              onClick={() => {
                setSaveError(null);
                const next = (bot?.versions[0]?.version ?? 0) + 1;
                setSaveLabel(`v${next}`);
              }}
              disabled={source === null}
              aria-label="Save version"
              title="Save a new version"
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setExpanded((value) => !value)}
              aria-pressed={expanded}
              aria-label={expanded ? 'Collapse the editor' : 'Expand the editor to full width'}
              title={expanded ? 'Collapse the editor' : 'Expand the editor to full width'}
            >
              {expanded ? <ArrowsIn /> : <ArrowsOut />}
            </button>
          </div>
          {source === null ? (
            <Skeleton lines={12} />
          ) : (
            <Suspense fallback={<Skeleton lines={12} />}>
              <CodeEditor value={source} onChange={setSource} label="Bot source code" />
            </Suspense>
          )}
          <ErrorMessage>{actionError}</ErrorMessage>
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
          <ConsolePanel lines={lines} onClear={() => setLines([])} />
        </div>

        <div className="arena-column" hidden={configTab !== 'code'}>
          <div className="editor-header-meta mono">
            {bot?.activeVersion ? (
              <span>v{bot.activeVersion.version}</span>
            ) : (
              <span>No version yet</span>
            )}
            {source !== null && source !== (activeSource ?? STARTER_SOURCE) ? (
              <span className="badge" title="The editor differs from the active version">
                Unsaved changes
              </span>
            ) : null}
            {bot?.rating ? <span>{formatRating(bot.rating.rating)} rating</span> : null}
            {bot?.queued ? <span className="badge badge-live">Queued</span> : null}
          </div>
          <div className="arena-frame">
            <ArenaCanvas onReady={setRenderer} label="Match arena" />
            <button
              type="button"
              className="icon-button arena-sound"
              onClick={() => setMuted((value) => !value)}
              aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
            >
              {muted ? <SpeakerSlash /> : <SpeakerHigh />}
            </button>
          </div>
          <Scoreboard
            snapshot={snapshot}
            entries={scoreEntries}
            maxTicks={DEFAULT_MAX_TICKS}
            mode={running || casual.match ? 'live' : 'idle'}
          />
          <Card className="panel local-test-panel">
            <h2>Test match</h2>
            <p className="muted">
              Runs entirely in your browser. Your draft plays as {participants[0]!.name}.
            </p>
            {[0, 1, 2].map((index) => (
              <label key={index} className="select-field">
                Opponent {index + 1}
                <select
                  value={opponents[index] ?? ''}
                  onChange={(event) => {
                    const next = [...opponents];
                    if (event.target.value) next[index] = event.target.value;
                    else next.splice(index, 1);
                    setOpponents(next.filter(Boolean));
                    setDrawn(null);
                  }}
                  disabled={index > opponents.length}
                >
                  {index > 0 ? <option value="">None</option> : null}
                  <option value={RANDOM}>Random house bot</option>
                  <optgroup label="House bots">
                    {SAMPLE_BOTS.map((sample) => (
                      <option key={sample.slug} value={sample.slug}>
                        {sample.name}
                      </option>
                    ))}
                  </optgroup>
                  {savedCode.own.length + savedCode.others.length > 0 ? (
                    <optgroup label="Your saved versions">
                      {[...savedCode.own, ...savedCode.others].map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </label>
            ))}
          </Card>
        </div>

        <div className="skin-config" hidden={configTab !== 'skins'}>
          <Card>
            <div className="card-header">
              <div>
                <h2>Bot skin</h2>
                <p className="muted">
                  Earn coins from ranked Elo to unlock skins. The arena uses a colour variant when
                  players share a skin.
                </p>
              </div>
              <span className="coin-balance">
                <Coins weight="fill" /> {store?.balance ?? 0} coins
              </span>
            </div>
            <div className="skin-grid">
              <article className={`skin-card ${bot?.skin === null ? 'is-selected' : ''}`}>
                <div
                  className="skin-preview"
                  role="img"
                  aria-label="Classic skin preview"
                  style={{ backgroundImage: 'url(/game/sprites/snes_white.png)' }}
                />
                <div>
                  <strong>Classic</strong>
                  <small className="muted">The default Bomber Arena look.</small>
                </div>
                <Button
                  variant={bot?.skin === null ? 'secondary' : 'primary'}
                  disabled={bot?.skin === null}
                  onClick={() => void equipSkin(null)}
                >
                  {bot?.skin === null ? 'Equipped' : 'Equip'}
                </Button>
              </article>
              {store?.skins.map((skin) => {
                const slug = skin.slug as SkinSlug;
                const owned = store.owned.includes(slug);
                const equipped = bot?.skin === slug;
                const canBuy = !owned && store.balance >= skin.price;
                const busy = buyingSkin === slug;
                return (
                  <article className={`skin-card ${equipped ? 'is-selected' : ''}`} key={slug}>
                    <div
                      className="skin-preview"
                      role="img"
                      aria-label={`${skin.name} skin preview`}
                      style={{
                        backgroundImage: `url(/game/skins/${slug}_white.png)`,
                      }}
                    />
                    <div>
                      <strong>{skin.name}</strong>
                      <small className="muted">{skin.description}</small>
                    </div>
                    <Button
                      variant={owned && !equipped ? 'primary' : owned ? 'secondary' : 'primary'}
                      disabled={busy || equipped || (!owned && !canBuy)}
                      busy={busy}
                      onClick={() => void (owned ? equipSkin(slug) : buySkin(slug))}
                    >
                      {equipped ? 'Equipped' : owned ? 'Equip' : `${skin.price} coins`}
                    </Button>
                  </article>
                );
              })}
            </div>
            {!store ? <Skeleton lines={2} /> : null}
            <ErrorMessage>{actionError}</ErrorMessage>
          </Card>
        </div>

        <div className="play-config" hidden={configTab !== 'play'}>
          <div className="tabs" role="tablist" aria-label="Match modes">
            {(
              [
                ['ranked', 'Ranked', <Trophy key="i" />],
                ['online', 'Online casual', <Globe key="i" />],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={panel === id}
                className="tab"
                onClick={() => setPanel(id)}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {panel === 'online' ? (
            <Card className="panel">
              <p className="muted">
                The server runs the match and asks your browser for each move, so your code stays on
                your machine. Casual results never change your rating.
              </p>
              {!casual.lobby ? (
                <div className="stack">
                  <Button
                    variant="primary"
                    onClick={() => casual.create(bot?.name ?? 'Browser bot', botId)}
                  >
                    Create a room
                  </Button>
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void casual.join(roomCode, bot?.name ?? 'Browser bot', botId);
                    }}
                  >
                    <label className="select-field">
                      Room code
                      <input
                        value={roomCode}
                        maxLength={6}
                        onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                        placeholder="K3Q9ZD"
                      />
                    </label>
                    <Button type="submit">Join</Button>
                  </form>
                </div>
              ) : (
                <div className="stack">
                  <p>
                    Room <strong className="mono">{casual.lobby.code}</strong>{' '}
                    {casual.lobby.status === 'playing' ? '(match in progress)' : ''}
                  </p>
                  <ul className="plain-list">
                    {casual.lobby.members.map((member) => (
                      <li key={member.userId}>
                        {member.botName} <span className="muted">by {member.displayName}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="toolbar">
                    {isHost && casual.lobby.status === 'waiting' ? (
                      <Button
                        variant="primary"
                        onClick={() => {
                          local.stop();
                          void casual.start(
                            drawOpponents(
                              opponents
                                .filter((slug) => !isSaved(slug))
                                .slice(0, 4 - casual.lobby!.members.length),
                            ),
                          );
                        }}
                        disabled={casual.lobby.members.length + opponents.length < 2}
                      >
                        Start match
                      </Button>
                    ) : null}
                    <Button onClick={casual.leave}>Leave room</Button>
                  </div>
                  {casual.match && casual.snapshot?.status === 'finished' ? (
                    <Link to={tvPath(casual.match.init.matchId)}>Match over. Watch the replay</Link>
                  ) : null}
                  <p className="field-hint">
                    Empty seats are filled with the opponents picked in Local test (random house
                    bots by default).
                  </p>
                </div>
              )}
            </Card>
          ) : null}

          {panel === 'ranked' ? (
            <Card className="panel">
              <p className="muted">
                Ranked matches run your active version in an isolated sandbox on the server. Each
                turn gets 100 ms of CPU and must answer within {DECISION_BUDGET_MS} ms (less for a
                player sped up by roller skates), or it is skipped. Only these matches change your
                rating.
              </p>
              <div className="toolbar">
                <Button
                  variant={bot?.queued ? 'secondary' : 'primary'}
                  icon={<Trophy />}
                  onClick={toggleQueue}
                  disabled={!bot?.activeVersion}
                >
                  {bot?.queued ? 'Leave the queue' : 'Queue for ranked'}
                </Button>
                <Link to="/">Watch live matches</Link>
              </div>
              {!bot?.activeVersion ? <p className="field-hint">Save a version first.</p> : null}
              {ranked ? (
                <p className="field-hint">
                  {ranked.queueLength} bots waiting, {ranked.liveMatches.length} matches live.
                </p>
              ) : null}
              {ranked?.liveMatches
                .filter((match) =>
                  match.participants.some((participant) => participant.botId === botId),
                )
                .map((match) => (
                  <Link key={match.id} to={tvPath(match.id)}>
                    Your bot is playing now. Watch the match
                  </Link>
                ))}
              <h3>Versions</h3>
              {bot && bot.versions.length > 0 ? (
                <ul className="version-list">
                  {bot.versions.map((version) => (
                    <li key={version.id}>
                      <span>
                        <strong>v{version.version}</strong>{' '}
                        {version.label ? (
                          <span className="version-label">{version.label}</span>
                        ) : null}{' '}
                        <span className="muted">{formatDate(version.createdAt)}</span>
                        {version.id === bot.activeVersion?.id ? (
                          <span className="badge">Active</span>
                        ) : null}
                        {version.visibility === 'public' ? (
                          <span className="badge">Public</span>
                        ) : null}
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => void loadCode(savedKey(botId, version.id))}
                      >
                        Load
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-hint">No versions yet.</p>
              )}
              <Button variant="danger" onClick={deleteBot}>
                Delete bot
              </Button>
            </Card>
          ) : null}
        </div>
      </div>

      <Modal
        open={saveLabel !== null}
        title="Save a version"
        onClose={() => {
          if (!submitting) setSaveLabel(null);
        }}
      >
        <form onSubmit={submit}>
          <Field
            label="Version name"
            value={saveLabel ?? ''}
            onChange={(event) => setSaveLabel(event.target.value)}
            placeholder={`v${(bot?.versions[0]?.version ?? 0) + 1}`}
            maxLength={60}
            required
            autoFocus
            hint="You can rename it, or keep the default. It becomes the version used for ranked play."
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={visibility === 'public'}
              onChange={(event) => setVisibility(event.target.checked ? 'public' : 'private')}
            />
            Public source: anyone can read this version
          </label>
          <label className="checkbox ranked-save-toggle">
            <input
              type="checkbox"
              checked={rankedOnSave}
              onChange={(event) => setRankedOnSave(event.target.checked)}
            />
            <span>
              <strong>Queue for ranked play</strong>
              <small className="muted">
                Enabled by default. Your newly saved version starts earning Elo and coins.
              </small>
            </span>
          </label>
          <ErrorMessage>{saveError}</ErrorMessage>
          <div className="modal-actions">
            <Button onClick={() => setSaveLabel(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={<CloudArrowUp />}
              busy={submitting}
              disabled={!saveLabel?.trim()}
            >
              Save version
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
