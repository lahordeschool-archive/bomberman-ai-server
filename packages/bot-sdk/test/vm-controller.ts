import vm from 'node:vm';
import { TICK_MS } from '@bomberman/game-engine';
import {
  BOT_HARNESS,
  BOT_TRAILER,
  type BotController,
  type HarnessOutput,
  parseHarnessOutput,
} from '../src/index.ts';

interface HarnessApi {
  seed(seed: number): void;
  call(json: string, now: number): void;
  read(): string;
}

/** Test-only host that runs bot code with the shared harness inside a node:vm context. */
export function createVmController(
  source: string,
  seed: number,
): BotController & { last?: HarnessOutput } {
  const context = vm.createContext({});
  vm.runInContext(BOT_HARNESS, context);
  vm.runInContext(source + BOT_TRAILER, context, { timeout: 1000 });
  const api = (context as { __bomber: HarnessApi }).__bomber;
  api.seed(seed);
  const controller: BotController & { last?: HarnessOutput } = {
    async decide(observation) {
      api.call(JSON.stringify(observation), observation.tick * TICK_MS);
      await new Promise((resolve) => setImmediate(resolve));
      const output = parseHarnessOutput(api.read());
      controller.last = output;
      if (output.error) throw new Error(output.error);
      return output.result;
    },
  };
  return controller;
}
