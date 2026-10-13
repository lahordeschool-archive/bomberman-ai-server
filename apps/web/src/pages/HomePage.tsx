import { SAMPLE_BOTS } from '@bomberman/bot-sdk';
import { Code, Flask, Robot, Trophy } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { TaglineReveal } from '../components/TaglineReveal.tsx';
import { Button } from '../components/ui.tsx';
import { ArenaCanvas } from '../game/ArenaCanvas.tsx';
import type { ArenaRenderer } from '../game/renderer.ts';
import { Scoreboard } from '../game/Scoreboard.tsx';
import { useLocalMatch } from '../game/useLocalMatch.ts';
import { useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';
import { DashboardPage } from './DashboardPage.tsx';

const DEMO = [SAMPLE_BOTS[1]!, SAMPLE_BOTS[0]!, SAMPLE_BOTS[1]!, SAMPLE_BOTS[0]!];

function DemoArena() {
  const [renderer, setRenderer] = useState<ArenaRenderer | null>(null);
  const { snapshot, status, start } = useLocalMatch(renderer);
  const restartTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!renderer) return;
    if (status === 'idle' || status === 'error') {
      void start(
        DEMO.map((bot) => ({ name: bot.name, source: bot.source })),
        { maxTicks: 90 * 20 },
      );
    }
    if (status === 'finished') {
      restartTimer.current = setTimeout(
        () =>
          void start(
            DEMO.map((bot) => ({ name: bot.name, source: bot.source })),
            { maxTicks: 90 * 20 },
          ),
        2500,
      );
    }
    return () => clearTimeout(restartTimer.current);
  }, [renderer, status, start]);

  return (
    <div className="demo-arena">
      <ArenaCanvas onReady={setRenderer} label="Sample bots playing a match in your browser" />
      <Scoreboard
        snapshot={snapshot}
        entries={DEMO.map((bot, slot) => ({ slot, name: bot.name }))}
        maxTicks={90 * 20}
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
            <p>Every 250 ms your function reads the grid and returns a move or a bomb.</p>
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
