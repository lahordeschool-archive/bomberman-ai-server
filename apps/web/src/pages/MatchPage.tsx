import { type MatchResult, type Snapshot, TICK_MS } from '@bomberman/game-engine';
import type { MatchInit, MatchSummary } from '@bomberman/protocol';
import {
  Pause,
  Play,
  SealCheck,
  SealWarning,
  SpeakerHigh,
  SpeakerSlash,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  ErrorMessage,
  formatDate,
  formatRating,
  Skeleton,
} from '../components/ui.tsx';
import { ArenaCanvas } from '../game/ArenaCanvas.tsx';
import { MatchEndOverlay } from '../game/MatchEndOverlay.tsx';
import type { ArenaRenderer } from '../game/renderer.ts';
import {
  entriesFromSummary,
  formatClock,
  Scoreboard,
  type ScoreboardEntry,
} from '../game/Scoreboard.tsx';
import { buildTimeline, type ReplayTimeline } from '../game/timeline.ts';
import { api, RequestError } from '../lib/api.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';
import { emitWithAck, getSocket } from '../lib/socket.ts';

const SPEEDS = [1, 2, 4, 8];

function ReplayPlayer({
  timeline,
  renderer,
  onSnapshot,
  startAtEnd,
}: {
  timeline: ReplayTimeline;
  renderer: ArenaRenderer | null;
  onSnapshot: (snapshot: Snapshot) => void;
  /** Opens on the final frame, paused: the viewer just watched the match live. */
  startAtEnd: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(!startAtEnd);
  const [speed, setSpeed] = useState(1);
  const indexRef = useRef(0);
  const last = timeline.snapshots.length - 1;

  const show = useCallback(
    (next: number, instant: boolean) => {
      const clamped = Math.max(0, Math.min(last, next));
      indexRef.current = clamped;
      setIndex(clamped);
      const snapshot = timeline.snapshots[clamped]!;
      if (instant) renderer?.reset(snapshot);
      else renderer?.push(snapshot);
      onSnapshot(snapshot);
    },
    [last, renderer, timeline, onSnapshot],
  );

  useEffect(() => {
    show(startAtEnd ? last : 0, true);
    if (startAtEnd) renderer?.halt();
    // Only when the replay or the canvas changes, not when playback is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  useEffect(() => {
    if (!playing) renderer?.halt();
  }, [playing, renderer]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (indexRef.current >= last) {
        setPlaying(false);
        return;
      }
      for (let step = 1; step <= speed; step++) {
        const next = indexRef.current + 1;
        if (next > last) break;
        show(next, false);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, last, show]);

  return (
    <div className="replay-controls">
      <Button
        variant="secondary"
        icon={playing ? <Pause /> : <Play />}
        onClick={() => {
          if (!playing && indexRef.current >= last) show(0, true);
          setPlaying((value) => !value);
        }}
      >
        {playing ? 'Pause' : 'Play'}
      </Button>
      <input
        type="range"
        min={0}
        max={last}
        value={index}
        aria-label="Replay position"
        onChange={(event) => {
          setPlaying(false);
          show(Number(event.target.value), true);
          renderer?.halt();
        }}
      />
      <span className="mono">
        {formatClock(index)} / {formatClock(last)}
      </span>
      <select
        value={speed}
        onChange={(event) => setSpeed(Number(event.target.value))}
        aria-label="Playback speed"
      >
        {SPEEDS.map((value) => (
          <option key={value} value={value}>
            {value}x
          </option>
        ))}
      </select>
    </div>
  );
}

export default function MatchPage({ matchId }: { matchId: string }) {
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [liveInit, setLiveInit] = useState<MatchInit | null>(null);
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<MatchResult | null>(null);
  const { user } = useSession();
  const { navigate } = useRouter();
  const backToMatches = useCallback(() => navigate('/matches'), [navigate]);
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;

  const loadReplay = useCallback(async () => {
    try {
      setTimeline(buildTimeline(await api.replay(matchId)));
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [matchId]);

  useEffect(() => {
    let cancelled = false;
    const socket = getSocket();
    const onSnapshot = ({
      matchId: id,
      snapshot: next,
    }: {
      matchId: string;
      snapshot: Snapshot;
    }) => {
      if (id !== matchId) return;
      rendererRef.current?.push(next);
      setSnapshot(next);
      if (next.result) setLiveResult(next.result);
    };
    const onEnd = ({ matchId: id, result }: { matchId: string; result: MatchResult }) => {
      if (id !== matchId) return;
      setLiveResult(result);
      api.match(matchId).then(
        (match) => {
          setSummary(match);
          if (match.status === 'completed') void loadReplay();
        },
        () => undefined,
      );
    };
    const watch = async () => {
      const init = await emitWithAck<MatchInit>('match:watch', { matchId });
      if (cancelled) return;
      setLiveInit(init);
      rendererRef.current?.reset(init.snapshot);
      setSnapshot(init.snapshot);
    };

    /** The match can finish between reading its summary and joining the live stream. */
    const showStored = async (attempt = 0): Promise<void> => {
      const match = await api.match(matchId);
      if (cancelled) return;
      setSummary(match);
      if (match.status === 'completed') return loadReplay();
      if (match.status === 'running' && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return showStored(attempt + 1);
      }
    };

    socket.on('match:snapshot', onSnapshot);
    socket.on('match:end', onEnd);
    api
      .match(matchId)
      .then(async (match) => {
        if (cancelled) return;
        setSummary(match);
        if (match.status === 'running') await watch().catch(() => showStored());
        else if (match.status === 'completed') await loadReplay();
      })
      .catch(async (failure) => {
        if (failure instanceof RequestError && failure.status === 404) {
          await watch().catch(() => setError('This match does not exist or has already ended.'));
        } else setError((failure as Error).message);
      });
    return () => {
      cancelled = true;
      socket.off('match:snapshot', onSnapshot);
      socket.off('match:end', onEnd);
      socket.emit('match:unwatch', { matchId });
    };
  }, [matchId, loadReplay]);

  useEffect(() => {
    if (liveInit && renderer) renderer.reset(snapshot ?? liveInit.snapshot);
    // Only when the canvas becomes available after the live stream started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer]);

  useEffect(() => renderer?.setMuted(muted), [renderer, muted]);

  const ownSlots = (summary?.participants ?? [])
    .filter((participant) => user && participant.owner?.username === user.username)
    .map((participant) => participant.slot)
    .join(',');
  useEffect(() => {
    renderer?.setHighlighted(ownSlots ? ownSlots.split(',').map(Number) : []);
  }, [renderer, ownSlots]);

  const entries: ScoreboardEntry[] = summary
    ? entriesFromSummary(summary)
    : (liveInit?.participants.map((participant) => ({
        slot: participant.slot,
        name: participant.name,
        detail: participant.owner,
      })) ?? []);
  const isLive =
    (summary?.status === 'running' || (!summary && liveInit)) && snapshot?.status !== 'finished';

  return (
    <div className="page match-page">
      <header className="page-header">
        <div>
          <Link to="/matches" className="muted">
            Matches
          </Link>
          <h1>
            {summary?.kind === 'casual' || (!summary && liveInit) ? 'Casual match' : 'Ranked match'}{' '}
            {isLive ? <span className="badge badge-live">Live</span> : null}
          </h1>
          {summary ? <p className="muted">{formatDate(summary.startedAt)}</p> : null}
        </div>
        {timeline ? (
          <p className={`verify ${timeline.verified ? 'ok' : 'bad'}`}>
            {timeline.verified ? <SealCheck /> : <SealWarning />}
            {timeline.verified
              ? 'Replay verified: your browser re-simulated the same final state.'
              : 'Replay mismatch: the re-simulated state differs from the recorded one.'}
          </p>
        ) : null}
      </header>
      <ErrorMessage>{error}</ErrorMessage>
      <div className="match-layout">
        <div>
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
            {liveInit ? (
              <MatchEndOverlay
                remainingTicks={isLive && snapshot ? liveInit.maxTicks - snapshot.tick : null}
                result={liveResult}
                names={Object.fromEntries(entries.map((entry) => [entry.slot, entry.name]))}
                onLeave={backToMatches}
              />
            ) : null}
          </div>
          {timeline ? (
            <ReplayPlayer
              timeline={timeline}
              renderer={renderer}
              onSnapshot={setSnapshot}
              startAtEnd={liveInit !== null}
            />
          ) : summary?.status === 'completed' && !error ? (
            <Skeleton lines={1} height={40} />
          ) : null}
          {summary?.status === 'completed' && error ? (
            <Button onClick={loadReplay}>Retry loading the replay</Button>
          ) : null}
        </div>
        <div className="stack">
          <Scoreboard
            snapshot={snapshot}
            entries={entries}
            maxTicks={isLive ? liveInit?.maxTicks : undefined}
            mode={isLive ? 'live' : 'replay'}
          />
          {summary && summary.status === 'completed' ? (
            <Card>
              <h2>Result</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Place</th>
                    <th>Bot</th>
                    <th>Kills</th>
                    <th>Score</th>
                    <th>Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {[...summary.participants]
                    .sort((a, b) => (a.placement ?? 9) - (b.placement ?? 9))
                    .map((participant) => {
                      const delta =
                        participant.ratingAfter !== null && participant.ratingBefore !== null
                          ? Math.round(participant.ratingAfter - participant.ratingBefore)
                          : null;
                      return (
                        <tr key={participant.slot}>
                          <td className="mono">#{participant.placement}</td>
                          <td>
                            {participant.botId ? (
                              <Link to={`/bots/${participant.botId}`}>{participant.botName}</Link>
                            ) : (
                              participant.botName
                            )}
                            {participant.owner ? (
                              <small className="muted">
                                {' '}
                                <Link to={`/u/${participant.owner.username}`}>
                                  {participant.owner.displayName}
                                </Link>
                              </small>
                            ) : null}
                          </td>
                          <td className="mono">{participant.kills}</td>
                          <td className="mono">{participant.score}</td>
                          <td className="mono">
                            {formatRating(participant.ratingAfter)}{' '}
                            {delta !== null ? (
                              <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
                                {delta >= 0 ? `+${delta}` : delta}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
