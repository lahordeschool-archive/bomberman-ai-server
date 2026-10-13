import {
  DECISION_BUDGET_MS,
  SAMPLE_BOTS,
  STARTER_SOURCE,
  type BotLogLine,
} from '@bomberman/bot-sdk';
import { DEFAULT_MAX_TICKS } from '@bomberman/game-engine';
import type { BotDetail, RankedStatus } from '@bomberman/protocol';
import {
  ArrowCounterClockwise,
  ArrowsIn,
  ArrowsOut,
  CloudArrowUp,
  Globe,
  PencilSimple,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  Stop,
  Trophy,
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
  formatDate,
  formatRating,
  Skeleton,
} from '../components/ui.tsx';
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
const ACTIVE_VERSION = 'active-version';
const MAX_CONSOLE_LINES = 300;
const EXPANDED_KEY = 'bomber:editor-expanded';

type Panel = 'test' | 'online' | 'ranked';

function draftKey(botId: string) {
  return `bomber:draft:${botId}`;
}

export default function BotEditorPage({ botId }: { botId: string }) {
  const { navigate } = useRouter();
  const { user } = useSession();
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const [muted, setMuted] = useState(true);
  const [panel, setPanel] = useState<Panel>('test');
  const [opponents, setOpponents] = useState<string[]>(['cautious-bomber', 'random-walker']);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ranked, setRanked] = useState<RankedStatus | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
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
            ? `No decision before the next turn: turns are being skipped. Answer within ${DECISION_BUDGET_MS} ms, and keep slow requests in the background.`
            : `Decision took ${Math.round(ms)} ms, over the ${DECISION_BUDGET_MS} ms budget: that turn was skipped.`,
          tick,
        ),
    }),
    [log],
  );

  const local = useLocalMatch(renderer);
  const casual = useCasualRoom(renderer, () => sourceRef.current, botEvents);

  const refresh = useCallback(async () => {
    const detail = await api.bot(botId);
    setBot(detail);
    let active: string | null = null;
    if (detail.activeVersion) {
      active = (await api.version(botId, detail.activeVersion.id)).source;
      setActiveSource(active);
    }
    return { detail, active };
  }, [botId]);

  useEffect(() => {
    refresh()
      .then(({ active }) => {
        setSource(
          (current) => current ?? localStorage.getItem(draftKey(botId)) ?? active ?? STARTER_SOURCE,
        );
      })
      .catch((failure: Error) => setLoadError(failure.message));
    api.rankedStatus().then(setRanked, () => undefined);
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

  const participants = useMemo(() => {
    const list = [
      { name: bot?.name ?? 'Your bot', source: source ?? '', detail: 'Draft', events: botEvents },
    ];
    for (const slug of opponents) {
      if (slug === ACTIVE_VERSION && activeSource) {
        list.push({
          name: `${bot?.name} v${bot?.activeVersion?.version}`,
          source: activeSource,
          detail: 'Active version',
          events: {},
        });
      } else {
        const sample = SAMPLE_BOTS.find((candidate) => candidate.slug === slug);
        if (sample)
          list.push({ name: sample.name, source: sample.source, detail: 'Sample bot', events: {} });
      }
    }
    return list;
  }, [bot, source, opponents, activeSource, botEvents]);

  function runTest() {
    casual.leave();
    log('system', `Starting a local match against ${participants.length - 1} opponents.`);
    void local.start(participants);
  }

  async function submit() {
    if (!source) return;
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    try {
      const version = await api.submitVersion(botId, source, visibility);
      await refresh();
      setNotice(`Saved as version ${version.version}. It is now the version used for ranked play.`);
    } catch (failure) {
      setActionError((failure as Error).message);
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

  async function loadVersion(versionId: string) {
    try {
      const version = await api.version(botId, versionId);
      if (version.source !== null) {
        setSource(version.source);
        log('system', `Loaded version ${version.version} into the editor.`);
      }
    } catch (failure) {
      setActionError((failure as Error).message);
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
      navigate('/');
    } catch (failure) {
      setActionError((failure as Error).message);
    }
  }

  if (loadError) {
    return (
      <div className="page">
        <ErrorMessage>{loadError}</ErrorMessage>
        <Link to="/">Back to your dashboard</Link>
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
      }))
    : participants.map((participant, slot) => ({
        slot,
        name: participant.name,
        detail: participant.detail,
      }));
  const running = local.status === 'loading' || local.status === 'running';
  const isHost = casual.lobby?.hostUserId === user?.id;

  return (
    <div className={expanded ? 'editor-page is-expanded' : 'editor-page'}>
      <header className="editor-header">
        <div>
          <Link to="/" className="muted">
            Dashboard
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
      </header>

      <div className="editor-layout">
        <div className="editor-column">
          <div className="editor-toolbar">
            <Button
              variant="primary"
              icon={running ? <ArrowCounterClockwise /> : <Play />}
              onClick={runTest}
              disabled={source === null}
            >
              {running ? 'Restart test' : 'Run test'}
            </Button>
            <Button icon={<Stop />} onClick={local.stop} disabled={!running}>
              Stop
            </Button>
            <span className="toolbar-spacer" />
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
            <label className="checkbox">
              <input
                type="checkbox"
                checked={visibility === 'public'}
                onChange={(event) => setVisibility(event.target.checked ? 'public' : 'private')}
              />
              Public source
            </label>
            <Button
              icon={<CloudArrowUp />}
              onClick={submit}
              busy={submitting}
              disabled={source === null}
            >
              Save version
            </Button>
          </div>
          {source === null ? (
            <Skeleton lines={12} />
          ) : (
            <Suspense fallback={<Skeleton lines={12} />}>
              <CodeEditor value={source} onChange={setSource} label="Bot source code" />
            </Suspense>
          )}
          <ErrorMessage>{actionError ?? local.error ?? casual.error}</ErrorMessage>
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
          <ConsolePanel lines={lines} onClear={() => setLines([])} />
        </div>

        <div className="arena-column">
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

          <div className="tabs" role="tablist" aria-label="Match modes">
            {(
              [
                ['test', 'Local test', <Play key="i" />],
                ['online', 'Online casual', <Globe key="i" />],
                ['ranked', 'Ranked', <Trophy key="i" />],
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

          {panel === 'test' ? (
            <Card className="panel">
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
                    }}
                    disabled={index > opponents.length}
                  >
                    {index > 0 ? <option value="">None</option> : null}
                    {SAMPLE_BOTS.map((sample) => (
                      <option key={sample.slug} value={sample.slug}>
                        {sample.name}
                      </option>
                    ))}
                    {activeSource ? (
                      <option value={ACTIVE_VERSION}>Your active version</option>
                    ) : null}
                  </select>
                </label>
              ))}
            </Card>
          ) : null}

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
                    onClick={() => casual.create(bot?.name ?? 'Browser bot')}
                  >
                    Create a room
                  </Button>
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void casual.join(roomCode, bot?.name ?? 'Browser bot');
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
                            opponents
                              .filter((slug) => slug !== ACTIVE_VERSION)
                              .slice(0, 4 - casual.lobby!.members.length),
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
                    <Link to={`/matches/${casual.match.init.matchId}`}>
                      Match over. Watch the replay
                    </Link>
                  ) : null}
                  <p className="field-hint">
                    Empty seats are filled with the sample bots picked in Local test.
                  </p>
                </div>
              )}
            </Card>
          ) : null}

          {panel === 'ranked' ? (
            <Card className="panel">
              <p className="muted">
                Ranked matches run your active version in an isolated sandbox on the server. Each
                turn gets 100 ms of CPU and must answer within {DECISION_BUDGET_MS} ms, or it is
                skipped. Only these matches change your rating.
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
                <Link to="/matches">Watch live matches</Link>
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
                  <Link key={match.id} to={`/matches/${match.id}`}>
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
                        <span className="muted">{formatDate(version.createdAt)}</span>
                        {version.id === bot.activeVersion?.id ? (
                          <span className="badge">Active</span>
                        ) : null}
                        {version.visibility === 'public' ? (
                          <span className="badge">Public</span>
                        ) : null}
                      </span>
                      <Button variant="ghost" onClick={() => loadVersion(version.id)}>
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
    </div>
  );
}
