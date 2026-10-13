import { botSeed, type Observation } from '@bomberman/bot-sdk';
import type { Snapshot } from '@bomberman/game-engine';
import type { CasualLobby, MatchInit } from '@bomberman/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type BrowserBot, createBrowserBot } from '../bots/browser-bot.ts';
import type { WorkerBotEvents } from '../bots/worker-bot.ts';
import { emitWithAck, getSocket } from '../lib/socket.ts';
import type { ArenaRenderer } from './renderer.ts';

/**
 * Casual online rooms: the server runs the authoritative match and asks this browser
 * for your bot's decisions; your code never leaves your machine. Results are unranked.
 */
export function useCasualRoom(
  renderer: ArenaRenderer | null,
  getSource: () => string,
  events: WorkerBotEvents,
) {
  const [lobby, setLobby] = useState<CasualLobby | null>(null);
  const [match, setMatch] = useState<{ init: MatchInit; slot: number } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bot = useRef<BrowserBot | null>(null);
  const loading = useRef<Promise<BrowserBot | null>>(Promise.resolve(null));
  const matchId = useRef<string | null>(null);
  const mySlot = useRef(0);
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const sourceRef = useRef(getSource);
  sourceRef.current = getSource;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    const socket = getSocket();
    const onLobby = (next: CasualLobby | null) => setLobby(next);
    const onMatch = async ({ matchId: id, slot }: { matchId: string; slot: number }) => {
      matchId.current = id;
      mySlot.current = slot;
      bot.current?.dispose();
      bot.current = null;
      const created = createBrowserBot(
        sourceRef.current(),
        botSeed(Date.now(), slot),
        eventsRef.current,
      ).then(
        (loaded) => {
          if (matchId.current !== id) {
            loaded.dispose();
            return null;
          }
          bot.current = loaded;
          return loaded;
        },
        (loadError: Error) => {
          setError(`Your bot failed to load: ${loadError.message}`);
          return null;
        },
      );
      loading.current = created;
      await created;
    };
    const onInit = (init: MatchInit) => {
      if (init.matchId !== matchId.current) return;
      setMatch({ init, slot: mySlot.current });
      rendererRef.current?.reset(init.snapshot);
      setSnapshot(init.snapshot);
    };
    const onSnapshot = ({
      matchId: id,
      snapshot: next,
    }: {
      matchId: string;
      snapshot: Snapshot;
    }) => {
      if (id !== matchId.current) return;
      rendererRef.current?.push(next);
      if (next.tick % 5 === 0 || next.status === 'finished') setSnapshot(next);
    };
    const onEnd = ({ matchId: id }: { matchId: string }) => {
      if (id !== matchId.current) return;
      bot.current?.dispose();
      bot.current = null;
    };
    const onObserve = (
      payload: { matchId: string; observation: unknown; budgetMs: number },
      ack: (action: unknown) => void,
    ) => {
      if (payload.matchId !== matchId.current) return ack(null);
      const ready = bot.current ? Promise.resolve(bot.current) : loading.current;
      ready
        .then((loaded) => {
          if (!loaded || payload.matchId !== matchId.current) return null;
          return loaded.decide(payload.observation as Observation, undefined, payload.budgetMs);
        })
        .then(ack, () => ack(null));
    };
    socket.on('casual:lobby', onLobby);
    socket.on('casual:match', onMatch);
    socket.on('match:init', onInit);
    socket.on('match:snapshot', onSnapshot);
    socket.on('match:end', onEnd);
    socket.on('bot:observe', onObserve);
    return () => {
      socket.off('casual:lobby', onLobby);
      socket.off('casual:match', onMatch);
      socket.off('match:init', onInit);
      socket.off('match:snapshot', onSnapshot);
      socket.off('match:end', onEnd);
      socket.off('bot:observe', onObserve);
      socket.emit('casual:leave');
      bot.current?.dispose();
    };
  }, []);

  const run = useCallback(async <T>(action: () => Promise<T>) => {
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError((failure as Error).message);
      return null;
    }
  }, []);

  return {
    lobby,
    match,
    snapshot,
    error,
    create: (botName: string) =>
      run(async () => setLobby(await emitWithAck<CasualLobby>('casual:create', { botName }))),
    join: (code: string, botName: string) =>
      run(async () => setLobby(await emitWithAck<CasualLobby>('casual:join', { code, botName }))),
    start: (houseBots: string[]) => run(() => emitWithAck('casual:start', { houseBots })),
    leave: () => {
      getSocket().emit('casual:leave');
      rendererRef.current?.halt();
      setLobby(null);
      setMatch(null);
      matchId.current = null;
    },
  };
}
