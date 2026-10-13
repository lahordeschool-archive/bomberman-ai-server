import type { Observation } from '@bomberman/bot-sdk';
import { WorkerBot, type WorkerBotEvents, WorkerStartError } from './worker-bot.ts';

export interface BrowserBot {
  decide(observation: Observation, signal?: AbortSignal, budgetMs?: number): Promise<unknown>;
  dispose(): void;
}

let workersBlocked = false;

/**
 * Runs bot code in a Web Worker, the fast path. Some embedded browsers never start
 * workers; after the first such failure every bot of the session runs in QuickJS instead.
 */
export async function createBrowserBot(
  source: string,
  seed: number,
  events: WorkerBotEvents = {},
): Promise<BrowserBot> {
  if (!workersBlocked) {
    try {
      return await WorkerBot.create(source, seed, events);
    } catch (error) {
      if (!(error instanceof WorkerStartError)) throw error;
      workersBlocked = true;
    }
  }
  const { QuickJsBot } = await import('./quickjs-bot.ts');
  return QuickJsBot.create(source, seed, events);
}
