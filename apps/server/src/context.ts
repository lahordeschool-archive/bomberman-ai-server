import type { Config } from './config.ts';
import type { Database } from './db/database.ts';
import type { BotExecutor } from './runner/executor.ts';
import type { HouseBot } from './store/house.ts';

export interface AppContext {
  config: Config;
  db: Database;
  executor: BotExecutor;
  house: HouseBot[];
  /** Asks the matchmaker to look at the queue now instead of at its next interval. */
  nudgeMatchmaker?: () => void;
}
