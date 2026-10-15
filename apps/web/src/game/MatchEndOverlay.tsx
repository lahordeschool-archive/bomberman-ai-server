import { type MatchResult, TICK_MS } from '@bomberman/game-engine';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui.tsx';

const COUNTDOWN_SECONDS = 5;

/**
 * Drawn over a live arena: a 5 to 1 countdown before the time limit, then the
 * outcome and a countdown back to the match list.
 */
export function MatchEndOverlay({
  remainingTicks,
  result,
  names,
  onLeave,
  leaveLabel = 'Back to Live',
  leaveCountdown = 'Back to Live in',
}: {
  /** Ticks left before the time limit while the match runs, null otherwise. */
  remainingTicks: number | null;
  result: MatchResult | null;
  names: Record<number, string>;
  onLeave: () => void;
  leaveLabel?: string;
  leaveCountdown?: string;
}) {
  const [leaveIn, setLeaveIn] = useState(COUNTDOWN_SECONDS);
  const [stayed, setStayed] = useState(false);
  const finished = result !== null;

  useEffect(() => {
    if (!finished || stayed) return;
    const timer = setInterval(() => setLeaveIn((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, [finished, stayed]);

  useEffect(() => {
    if (finished && !stayed && leaveIn <= 0) onLeave();
  }, [finished, stayed, leaveIn, onLeave]);

  if (result) {
    if (stayed) return null;
    const winner = result.winnerId === null ? null : (names[result.winnerId] ?? null);
    return (
      <div className="arena-overlay" role="status">
        <div className="match-end">
          <p className="match-end-title">
            {result.reason === 'timeout' ? "Time's up!" : 'Game over'}
          </p>
          <p className="match-end-winner">{winner ? `${winner} wins` : 'Draw'}</p>
          <p className="muted">
            {leaveCountdown} {Math.max(0, leaveIn)}…
          </p>
          <div className="match-end-actions">
            <Button variant="secondary" onClick={() => setStayed(true)}>
              Stay and see the result
            </Button>
            <Button onClick={onLeave}>{leaveLabel}</Button>
          </div>
        </div>
      </div>
    );
  }

  if (remainingTicks === null || remainingTicks <= 0) return null;
  const seconds = Math.ceil((remainingTicks * TICK_MS) / 1000);
  if (seconds > COUNTDOWN_SECONDS) return null;
  return (
    <div className="arena-overlay" aria-live="polite">
      <span key={seconds} className="arena-countdown">
        {seconds}
      </span>
    </div>
  );
}
