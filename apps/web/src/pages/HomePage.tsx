import { randomSampleBots, type SampleBot } from '@bomberman/bot-sdk';
import { type Snapshot, TICK_MS } from '@bomberman/game-engine';
import type { MatchSummary } from '@bomberman/protocol';
import { Code, Flask, Robot, Trophy } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { TaglineReveal } from '../components/TaglineReveal.tsx';
import { Button } from '../components/ui.tsx';
import { ArenaCanvas } from '../game/ArenaCanvas.tsx';
import type { ArenaRenderer } from '../game/renderer.ts';
import { entriesFromSummary, Scoreboard } from '../game/Scoreboard.tsx';
import { buildTimeline } from '../game/timeline.ts';
import { useLocalMatch } from '../game/useLocalMatch.ts';
import { api } from '../lib/api.ts';
import { useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';
import { DashboardPage } from './DashboardPage.tsx';

const DEMO_TICKS = 90 * 20;

const REPLAY_POOL = 12;

/** Replays recent ranked matches: server results, so it needs no Web Workers in the browser. */
function ReplayDemo({ matches }: { matches: MatchSummary[] }) {
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const [current, setCurrent] = useState<MatchSummary | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const next = useRef(0);

  useEffect(() => {
    if (!renderer) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const playNext = async () => {
      const summary = matches[next.current++ % matches.length]!;
      try {
        const { snapshots } = buildTimeline(await api.replay(summary.id));
        if (cancelled) return;
        setCurrent(summary);
        renderer.reset(snapshots[0]!);
        setSnapshot(snapshots[0]!);
        let index = 0;
        const advance = () => {
          if (cancelled) return;
          index += 1;
          const frame = snapshots[index];
          if (!frame) {
            timer = setTimeout(() => void playNext(), 2500);
            return;
          }
          renderer.push(frame);
          if (index % 5 === 0 || index === snapshots.length - 1) setSnapshot(frame);
          timer = setTimeout(advance, TICK_MS);
        };
        timer = setTimeout(advance, TICK_MS);
      } catch {
        if (!cancelled) timer = setTimeout(() => void playNext(), 5000);
      }
    };
    void playNext();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [renderer, matches]);

  return (
    <div className="demo-arena">
      <ArenaCanvas onReady={setRenderer} label="Replay of a recent ranked match" />
      <Scoreboard
        snapshot={snapshot}
        entries={current ? entriesFromSummary(current) : []}
        mode="replay"
      />
    </div>
  );
}

/** Before any ranked match exists, sample bots play live in the browser. */
function DemoArena() {
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);

  useEffect(() => {
    api.matches({ limit: REPLAY_POOL }).then(
      ({ matches: recent }) =>
        setMatches(
          recent
            .filter((match) => match.status === 'completed' && match.participants.length > 1)
            .sort(() => Math.random() - 0.5),
        ),
      () => setMatches([]),
    );
  }, []);

  if (matches === null) return <div className="demo-arena" />;
  return matches.length > 0 ? <ReplayDemo matches={matches} /> : <LocalDemo />;
}

function LocalDemo() {
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const [demo, setDemo] = useState(() => randomSampleBots(4));
  const { snapshot, status, start } = useLocalMatch(renderer);
  const restartTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const failures = useRef(0);

  useEffect(() => {
    if (!renderer) return;
    const play = (lineup: SampleBot[]) => {
      setDemo(lineup);
      void start(
        lineup.map((bot) => ({ name: bot.name, source: bot.source })),
        { maxTicks: DEMO_TICKS },
      );
    };
    if (status === 'idle') play(demo);
    if (status === 'running') failures.current = 0;
    if (status === 'error') {
      failures.current += 1;
      const delay = Math.min(30_000, 1000 * 2 ** failures.current);
      restartTimer.current = setTimeout(() => play(demo), delay);
    }
    if (status === 'finished') {
      restartTimer.current = setTimeout(() => play(randomSampleBots(4)), 2500);
    }
    return () => clearTimeout(restartTimer.current);
    // The lineup is chosen when a match starts, not as a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, status, start]);

  return (
    <div className="demo-arena">
      <ArenaCanvas onReady={setRenderer} label="Sample bots playing a match in your browser" />
      <Scoreboard
        snapshot={snapshot}
        entries={demo.map((bot, slot) => ({ slot, name: bot.name }))}
        maxTicks={DEMO_TICKS}
      />
    </div>
  );
}

function Landing() {
  const { navigate } = useRouter();
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="hero-title">
            Write the bot.
            <br />
            Watch it play Bomberman.
          </h1>
          <p className="hero-subtitle">
            Code a JavaScript gameLoop in your browser, test it against sample bots in seconds, then
            send it to the ranked ladder where every match runs on our servers.
          </p>
          <div className="hero-actions">
            <Button variant="primary" onClick={() => navigate('/register')}>
              Create your first bot
            </Button>
          </div>
          <p className="hero-proof">Free to play. A username and a password are all it takes.</p>
        </div>
        <DemoArena />
      </section>

      <section className="steps" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="steps-grid">
          <li>
            <Code aria-hidden />
            <h3>Write a gameLoop</h3>
            <p>Every 300 ms your function reads the grid and returns a move or a bomb.</p>
          </li>
          <li>
            <Flask aria-hidden />
            <h3>Test locally</h3>
            <p>Run matches against sample bots right in the editor, with console output.</p>
          </li>
          <li>
            <Trophy aria-hidden />
            <h3>Climb the ladder</h3>
            <p>Submit a version and queue it. Ranked matches run sandboxed on the server.</p>
          </li>
        </ol>
      </section>

      <TaglineReveal text="Your code holds the controller. Every move, every bomb, every narrow escape is a decision you wrote." />

      <section className="final-cta">
        <Robot aria-hidden size={40} />
        <h2>Ready for your first match?</h2>
        <Button variant="primary" onClick={() => navigate('/register')}>
          Create your first bot
        </Button>
      </section>
    </div>
  );
}

export function HomePage() {
  const { user, loading } = useSession();
  if (loading) return null;
  return user ? <DashboardPage /> : <Landing />;
}
