import { botSeed, DECISION_BUDGET_MS, runMatch } from '@bomberman/bot-sdk';
import { createGame, randomSeed, type Snapshot, TICK_MS, toSnapshot } from '@bomberman/game-engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type BrowserBot, createBrowserBot } from '../bots/browser-bot.ts';
import type { WorkerBotEvents } from '../bots/worker-bot.ts';
import type { ArenaRenderer } from './renderer.ts';
import type { SkinSlug } from '@bomberman/protocol';

export interface LocalParticipant {
  name: string;
  source: string;
  detail?: string;
  /** Console events are only reported for your own bot. */
  events?: WorkerBotEvents;
  skin?: SkinSlug | null;
}

export type LocalMatchStatus = 'idle' | 'loading' | 'running' | 'finished' | 'error';

/** Runs a full match in the browser: shared engine, every bot in its own Web Worker. */
export function useLocalMatch(renderer: ArenaRenderer | null) {
  const [status, setStatus] = useState<LocalMatchStatus>('idle');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    async (
      participants: LocalParticipant[],
      options: { seed?: number; maxTicks?: number } = {},
    ) => {
      stop();
      const controller = new AbortController();
      abort.current = controller;
      setStatus('loading');
      setError(null);
      const seed = options.seed ?? randomSeed();
      let bots: BrowserBot[] = [];
      try {
        const loads = participants.map((participant, index) =>
          createBrowserBot(participant.source, botSeed(seed, index), participant.events).catch(
            (loadError: Error) => {
              throw new Error(`${participant.name}: ${loadError.message}`);
            },
          ),
        );
        const settled = await Promise.allSettled(loads);
        bots = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
        const failed = settled.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
        if (controller.signal.aborted) return;
        const state = createGame({
          seed,
          playerCount: participants.length,
          settings: options.maxTicks ? { maxTicks: options.maxTicks } : undefined,
        });
        rendererRef.current?.setPlayerSkins(
          new Map(
            participants.flatMap((participant, slot) =>
              participant.skin ? [[slot, participant.skin] as const] : [],
            ),
          ),
        );
        const initial = toSnapshot(state, []);
        rendererRef.current?.reset(initial);
        setSnapshot(initial);
        setStatus('running');
        await runMatch({
          state,
          controllers: bots,
          tickMs: TICK_MS,
          decisionTimeoutMs: DECISION_BUDGET_MS,
          signal: controller.signal,
          onTick: (current) => {
            const next = toSnapshot(current);
            rendererRef.current?.push(next);
            if (current.tick % 5 === 0 || current.status === 'finished') setSnapshot(next);
          },
        });
        setStatus('finished');
      } catch (failure) {
        if (controller.signal.aborted) {
          if (abort.current === null) rendererRef.current?.halt();
          setStatus('idle');
        } else {
          setError(failure instanceof Error ? failure.message : String(failure));
          setStatus('error');
        }
      } finally {
        for (const bot of bots) bot.dispose();
        if (abort.current === controller) abort.current = null;
      }
    },
    [stop],
  );

  return { status, snapshot, error, start, stop };
}
