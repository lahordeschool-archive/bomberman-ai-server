import { type Snapshot, TICK_MS } from '@bomberman/game-engine';
import { Pause, Play } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArenaRenderer } from './renderer.ts';
import { formatClock } from './Scoreboard.tsx';
import type { ReplayTimeline } from './timeline.ts';

const SPEEDS = [1, 2, 4, 8];

export function ReplayPlayer({
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
  const currentTick = timeline.snapshots[index]?.tick ?? 0;
  const finalTick = timeline.snapshots[last]?.tick ?? 0;

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

  const toggle = () => {
    if (!playing && indexRef.current >= last) show(0, true);
    setPlaying((value) => !value);
  };

  return (
    <div className={playing ? 'replay-controls' : 'replay-controls is-paused'}>
      <button
        type="button"
        className="icon-button replay-toggle"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
      </button>
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
        {formatClock(currentTick)} / {formatClock(finalTick)}
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
