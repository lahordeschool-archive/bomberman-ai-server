import { parentPort, workerData } from 'node:worker_threads';
import { buildObservation, type Observation } from '@bomberman/bot-sdk';
import { createGame } from '@bomberman/game-engine';
import { Egress, type EgressPolicy } from './egress.ts';
import { BotLoadError, QuickJsBot, type SandboxLimits } from './sandbox.ts';

export type WorkerRequest =
  | { id: number; op: 'create'; sessionId: string; source: string; seed: number }
  | { id: number; op: 'act'; sessionId: string; observation: Observation; budgetMs: number }
  | { id: number; op: 'dispose'; sessionId: string }
  | { id: number; op: 'validate'; source: string };

export type WorkerResponse =
  { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string };

const { limits, egress: policy } = workerData as { limits: SandboxLimits; egress: EgressPolicy };
const egress = new Egress(policy);
const bots = new Map<string, QuickJsBot>();

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.op) {
    case 'create': {
      const bot = await QuickJsBot.create(request.source, request.seed, limits, egress);
      bots.set(request.sessionId, bot);
      return null;
    }
    case 'act': {
      const bot = bots.get(request.sessionId);
      if (!bot) throw new Error('Unknown session');
      return bot.act(request.observation, request.budgetMs);
    }
    case 'dispose': {
      bots.get(request.sessionId)?.dispose();
      bots.delete(request.sessionId);
      return null;
    }
    case 'validate': {
      const bot = await QuickJsBot.create(request.source, 1, limits, egress);
      try {
        const result = await bot.act(buildObservation(createGame({ seed: 1, playerCount: 4 }), 0));
        // A bot still waiting on a request is fine; only crashes reject the source.
        if (result.error && !result.late) throw new BotLoadError(result.error);
        return { action: result.action, logs: result.logs, durationMs: result.durationMs };
      } finally {
        bot.dispose();
      }
    }
  }
}

parentPort!.on('message', (request: WorkerRequest) => {
  handle(request).then(
    (data) => parentPort!.postMessage({ id: request.id, ok: true, data } satisfies WorkerResponse),
    (error: unknown) =>
      parentPort!.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse),
  );
});
