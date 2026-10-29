import type { MatchResult, Snapshot } from '@bomberman/game-engine';
import type { ChatMessage, MatchInit, MatchSummary, SkinSlug } from '@bomberman/protocol';
import {
  Broadcast,
  ClockCounterClockwise,
  Eye,
  SealCheck,
  SealWarning,
  SpeakerHigh,
  SpeakerSlash,
  Television,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArenaCanvas } from '../game/ArenaCanvas.tsx';
import { MatchEndOverlay } from '../game/MatchEndOverlay.tsx';
import type { ArenaRenderer } from '../game/renderer.ts';
import { ReplayPlayer } from '../game/ReplayPlayer.tsx';
import { entriesFromSummary, Scoreboard, type ScoreboardEntry } from '../game/Scoreboard.tsx';
import { buildTimeline, type ReplayTimeline } from '../game/timeline.ts';
import { capture } from '../lib/analytics.ts';
import { api } from '../lib/api.ts';
import { emitWithAck, getSocket } from '../lib/socket.ts';
import { MatchBrowser } from './MatchBrowser.tsx';
import {
  appendLines,
  type ChatLine,
  chatLine,
  lastNote,
  loadLines,
  saveLines,
  systemLine,
} from './chat-lines.ts';
import { MatchChat } from './MatchChat.tsx';
import { KIND_LABEL } from './MatchList.tsx';
import { Button } from './ui.tsx';

const POLL_MS = 5000;

/** What the TV shows: a running match streamed live, or a finished one replayed. */
type Channel = { mode: 'live'; id: string } | { mode: 'replay'; match: MatchSummary };

function viewersLabel(viewers: number): string {
  return `${viewers} ${viewers === 1 ? 'viewer' : 'viewers'}`;
}

/**
 * Twitch-style channel. On the Live page it streams one running match with its chat and
 * replays any finished match picked from the guide below it. Embedded on the landing
 * page, it only streams live matches, without chat or guide.
 */
export function BomberArenaTV({
  username,
  variant = 'full',
  onOffAir,
  tuneTo = null,
  onTuned,
}: {
  /** The signed-in viewer, whose bots are highlighted and who can chat. */
  username?: string;
  variant?: 'full' | 'embed';
  /** Called when nothing is live, so an embedding page can show something else. */
  onOffAir?: () => void;
  /** A match to open, from a link elsewhere on the site: live if running, else replayed. */
  tuneTo?: string | null;
  /** Called once `tuneTo` was handled, whether or not the match could be shown. */
  onTuned?: () => void;
}) {
  const embed = variant === 'embed';
  const [live, setLive] = useState<MatchSummary[] | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [init, setInit] = useState<MatchInit | null>(null);
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [viewers, setViewers] = useState<number | null>(null);
  const chatStorageKey = username ? `bomber-arena:chat:${username}` : null;
  const [chat, setChat] = useState<ChatLine[]>(() =>
    chatStorageKey ? loadLines(chatStorageKey) : [],
  );
  useEffect(() => {
    if (chatStorageKey) saveLines(chatStorageKey, chat);
  }, [chatStorageKey, chat]);
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const [muted, setMuted] = useState(true);
  const section = useRef<HTMLElement>(null);
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  /** Matches that ended or could not be joined; the live list can lag behind. */
  const gone = useRef(new Set<string>());
  const [goneIds, setGoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const markGone = useCallback((id: string) => {
    if (gone.current.has(id)) return;
    gone.current.add(id);
    setGoneIds(new Set(gone.current));
  }, []);

  const onAir = live?.filter((match) => !goneIds.has(match.id)) ?? null;
  const liveId = channel?.mode === 'live' ? channel.id : null;
  const replayMatch = channel?.mode === 'replay' ? channel.match : null;

  const refresh = useCallback(async () => {
    try {
      const { matches } = await api.liveMatches();
      setLive(matches);
      return matches;
    } catch {
      setLive((current) => current ?? []);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Tunes in to the first live match until the viewer picks something. */
  useEffect(() => {
    if (channel || !live || tuneTo) return;
    const first = live.find((match) => !gone.current.has(match.id));
    if (first) setChannel({ mode: 'live', id: first.id });
  }, [live, channel, tuneTo]);

  const liveIdRef = useRef(liveId);
  liveIdRef.current = liveId;
  const advancing = useRef(false);
  /** Moves on from the match that just ended; a no-op while the current one still runs. */
  const leave = useCallback(async () => {
    const current = liveIdRef.current;
    if (advancing.current || !current || !gone.current.has(current)) return;
    advancing.current = true;
    try {
      const matches = (await refresh()) ?? [];
      if (liveIdRef.current !== current) return;
      const candidate = matches.find((match) => !gone.current.has(match.id));
      setChannel(candidate ? { mode: 'live', id: candidate.id } : null);
    } finally {
      advancing.current = false;
    }
  }, [refresh]);

  const select = useCallback((match: MatchSummary) => {
    setChannel((current) => {
      const currentId = current?.mode === 'live' ? current.id : current?.match.id;
      if (currentId === match.id) return current;
      return match.status === 'running'
        ? { mode: 'live', id: match.id }
        : { mode: 'replay', match };
    });
    const top = section.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) section.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (!tuneTo) return;
    let cancelled = false;
    api
      .match(tuneTo)
      .then(
        (match) => {
          if (!cancelled && (match.status === 'running' || match.status === 'completed')) {
            select(match);
          }
        },
        () => undefined,
      )
      .finally(() => {
        if (!cancelled) onTuned?.();
      });
    return () => {
      cancelled = true;
    };
  }, [tuneTo, select, onTuned]);

  /**
   * The match the chat posts to. It outlives the stream: the room stays joined through
   * the result and the countdown, until the next live match is joined or a replay picked.
   */
  const [chatRoom, setChatRoom] = useState<string | null>(null);
  const chatRoomRef = useRef(chatRoom);
  const moveChat = useCallback((next: string | null) => {
    const previous = chatRoomRef.current;
    if (previous && previous !== next) getSocket().emit('match:unwatch', { matchId: previous });
    chatRoomRef.current = next;
    setChatRoom(next);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const onChat = (message: ChatMessage) => {
      if (message.matchId !== chatRoomRef.current) return;
      setChat((lines) => appendLines(lines, [chatLine(message)]));
    };
    socket.on('match:chat', onChat);
    return () => {
      socket.off('match:chat', onChat);
      const room = chatRoomRef.current;
      if (room) socket.emit('match:unwatch', { matchId: room });
    };
  }, []);

  useEffect(() => {
    setInit(null);
    setSnapshot(null);
    setResult(null);
    setViewers(null);
    rendererRef.current?.reset();
    if (!liveId) return;
    const matchId = liveId;
    let cancelled = false;
    let joined: MatchInit | null = null;
    const socket = getSocket();

    const watch = async () => {
      try {
        const init = await emitWithAck<MatchInit>('match:watch', { matchId });
        if (cancelled) return;
        const announce = joined === null;
        joined = init;
        setInit(init);
        setSnapshot(init.snapshot);
        rendererRef.current?.reset(init.snapshot);
        moveChat(matchId);
        const note = `Now watching ${init.participants.map((participant) => participant.name).join(' vs ')}`;
        setChat((lines) =>
          appendLines(
            lines,
            announce && lastNote(lines) !== note ? [systemLine(note)] : [],
            init.chat.map(chatLine),
          ),
        );
      } catch {
        if (cancelled) return;
        markGone(matchId);
        const matches = (await refresh()) ?? [];
        if (cancelled) return;
        const next = matches.find((match) => !gone.current.has(match.id));
        setChannel(next ? { mode: 'live', id: next.id } : null);
      }
    };
    const onSnapshot = ({
      matchId: id,
      snapshot: frame,
    }: {
      matchId: string;
      snapshot: Snapshot;
    }) => {
      if (id !== matchId) return;
      rendererRef.current?.push(frame);
      setSnapshot(frame);
      if (frame.result) setResult(frame.result);
    };
    const onEnd = ({ matchId: id, result: final }: { matchId: string; result: MatchResult }) => {
      if (id !== matchId) return;
      markGone(matchId);
      setResult(final);
      const winner =
        final.winnerId === null
          ? null
          : joined?.participants.find((participant) => participant.slot === final.winnerId)?.name;
      setChat((lines) =>
        appendLines(lines, [systemLine(winner ? `Game over: ${winner} wins` : 'Game over: draw')]),
      );
    };
    const onViewers = ({ matchId: id, viewers: count }: { matchId: string; viewers: number }) => {
      if (id === matchId) setViewers(count);
    };
    /** Rooms are per connection: after a dropped connection, join the match again. */
    let dropped = false;
    const onDisconnect = () => (dropped = true);
    const onReconnect = () => {
      if (!dropped) return;
      dropped = false;
      void watch();
    };

    socket.on('match:snapshot', onSnapshot);
    socket.on('match:end', onEnd);
    socket.on('match:viewers', onViewers);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onReconnect);
    void watch();
    return () => {
      cancelled = true;
      socket.off('match:snapshot', onSnapshot);
      socket.off('match:end', onEnd);
      socket.off('match:viewers', onViewers);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onReconnect);
      if (chatRoomRef.current !== matchId) socket.emit('match:unwatch', { matchId });
    };
  }, [liveId, refresh, markGone, moveChat]);

  useEffect(() => {
    setTimeline(null);
    setReplayError(null);
    if (!replayMatch) return;
    let cancelled = false;
    moveChat(null);
    capture('replay_opened', { matchId: replayMatch.id });
    api.replay(replayMatch.id).then(
      (replay) => !cancelled && setTimeline(buildTimeline(replay)),
      (failure: Error) => !cancelled && setReplayError(failure.message),
    );
    return () => {
      cancelled = true;
    };
  }, [replayMatch, moveChat]);

  useEffect(() => {
    if (renderer && snapshot) renderer.reset(snapshot);
    // Only when the canvas becomes available after the stream started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer]);

  useEffect(() => renderer?.setMuted(muted), [renderer, muted]);

  const summary = replayMatch ?? live?.find((match) => match.id === liveId) ?? null;
  const ownSlots = (summary?.participants ?? [])
    .filter((participant) => username && participant.owner?.username === username)
    .map((participant) => participant.slot)
    .join(',');
  useEffect(() => {
    renderer?.setHighlighted(ownSlots ? ownSlots.split(',').map(Number) : []);
  }, [renderer, ownSlots]);

  const skins = JSON.stringify(
    (summary?.participants ?? init?.participants ?? []).flatMap((participant) =>
      participant.skin ? [[participant.slot, participant.skin] as const] : [],
    ),
  );
  useEffect(() => {
    renderer?.setPlayerSkins(new Map(JSON.parse(skins) as [number, SkinSlug][]));
  }, [renderer, skins]);

  const entries: ScoreboardEntry[] = summary
    ? entriesFromSummary(summary)
    : (init?.participants.map((participant) => ({
        slot: participant.slot,
        name: participant.name,
        detail: participant.owner,
        skin: participant.skin,
      })) ?? []);
  const isLive = Boolean(init) && !result;
  const showing = Boolean(init || timeline);
  const shownId = liveId ?? replayMatch?.id ?? null;
  const status = replayMatch ? 'replay' : isLive ? 'live' : init ? 'ended' : 'off';
  const kind =
    summary?.tournament?.name ?? (init || replayMatch ? KIND_LABEL[(summary ?? init)!.kind] : null);
  const firstLive = onAir?.[0] ?? null;
  const offAir = onAir !== null && onAir.length === 0 && !channel;
  useEffect(() => {
    if (offAir) onOffAir?.();
  }, [offAir, onOffAir]);
  const shownViewers = liveId && init ? viewers : null;
  const Title = embed ? 'h2' : 'h1';

  return (
    <>
      <section ref={section} className={embed ? 'tv is-embed' : 'tv'} aria-labelledby="tv-title">
        <header className="tv-header">
          <Title id="tv-title" className="tv-title">
            <Television aria-hidden weight="fill" />
            Bomber Arena <span>TV</span>
          </Title>
          <div className="tv-header-meta">
            {replayMatch && firstLive ? (
              <Button
                variant="secondary"
                icon={<Broadcast />}
                onClick={() => setChannel({ mode: 'live', id: firstLive.id })}
              >
                Back to live
              </Button>
            ) : null}
          </div>
        </header>

        <div className="tv-body">
          <div className="tv-stage">
            <div className="tv-screen">
              <div className={`tv-status is-${status}`} role="status">
                <span className="tv-status-pill">
                  {status === 'replay' ? (
                    <ClockCounterClockwise aria-hidden weight="bold" />
                  ) : (
                    <span className="tv-status-dot" aria-hidden />
                  )}
                  {status === 'live'
                    ? 'Live'
                    : status === 'replay'
                      ? 'Replay'
                      : status === 'ended'
                        ? 'Ended'
                        : 'Off air'}
                </span>
                {kind ? <span className="tv-status-kind">{kind}</span> : null}
                {replayMatch && timeline ? (
                  <span
                    className={`tv-status-kind ${timeline.verified ? 'is-verified' : 'is-mismatch'}`}
                    title={
                      timeline.verified
                        ? 'Your browser re-simulated the match and reached the same final state.'
                        : 'The re-simulated final state differs from the recorded one.'
                    }
                  >
                    {timeline.verified ? (
                      <SealCheck aria-hidden weight="fill" />
                    ) : (
                      <SealWarning aria-hidden weight="fill" />
                    )}
                    {timeline.verified ? 'Verified' : 'Mismatch'}
                  </span>
                ) : null}
                {embed && shownViewers !== null ? (
                  <span className="tv-status-kind">
                    <Eye aria-hidden weight="bold" />
                    {viewersLabel(shownViewers)}
                  </span>
                ) : null}
              </div>
              <div className={`tv-arena${showing ? '' : ' is-idle'}`}>
                <ArenaCanvas onReady={setRenderer} label="Match on Bomber Arena TV" />
                {showing ? (
                  <button
                    type="button"
                    className="icon-button arena-sound"
                    onClick={() => setMuted((value) => !value)}
                    aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
                  >
                    {muted ? <SpeakerSlash /> : <SpeakerHigh />}
                  </button>
                ) : null}
                {init && init.matchId === liveId ? (
                  <MatchEndOverlay
                    key={init.matchId}
                    remainingTicks={isLive && snapshot ? init.maxTicks - snapshot.tick : null}
                    result={result}
                    names={Object.fromEntries(entries.map((entry) => [entry.slot, entry.name]))}
                    onLeave={leave}
                    leaveLabel="Next live match"
                    leaveCountdown="Next live match in"
                  />
                ) : replayMatch && timeline ? null : (
                  <div className="arena-overlay tv-standby">
                    {replayError ? (
                      <p className="muted">{replayError}</p>
                    ) : replayMatch ? (
                      <p className="muted">Loading the replay…</p>
                    ) : live === null || liveId || (onAir?.length ?? 0) > 0 ? (
                      <p className="muted">Tuning in…</p>
                    ) : (
                      <div>
                        <p className="tv-standby-title">Nothing on air right now</p>
                        <p className="muted">
                          Queue a bot for ranked play, or pick a finished match to replay it.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {replayMatch && timeline ? (
                <ReplayPlayer
                  key={replayMatch.id}
                  timeline={timeline}
                  renderer={renderer}
                  onSnapshot={setSnapshot}
                  startAtEnd={false}
                />
              ) : null}
            </div>
            <div className="tv-info">
              <Scoreboard
                snapshot={snapshot}
                entries={showing ? entries : []}
                maxTicks={isLive ? init?.maxTicks : undefined}
                mode={replayMatch && timeline ? 'replay' : init ? 'live' : 'idle'}
              />
            </div>
          </div>
          {embed ? null : (
            <MatchChat
              matchId={username && !replayMatch ? chatRoom : null}
              messages={replayMatch ? [] : chat}
              username={username ?? ''}
              viewers={shownViewers === null ? null : viewersLabel(shownViewers)}
              closedNotice={
                replayMatch
                  ? 'The chat is off during replays'
                  : username
                    ? undefined
                    : 'Sign in to chat'
              }
            />
          )}
        </div>
      </section>
      {embed ? null : <MatchBrowser live={onAir} selectedId={shownId} onSelect={select} />}
    </>
  );
}
