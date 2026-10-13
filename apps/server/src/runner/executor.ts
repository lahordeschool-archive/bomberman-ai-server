import type { BotController, BotLogLine, Observation } from '@bomberman/bot-sdk';

export interface SandboxSession extends BotController {
  dispose(): Promise<void>;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Where untrusted bot code runs. In production this is always the isolated bot-runner. */
export interface BotExecutor {
  validate(source: string): Promise<ValidationResult>;
  createSession(source: string, seed: number): Promise<SandboxSession>;
  healthy(): Promise<boolean>;
}

/** Leaves room for the round trip so the runner answers before the match drops the turn. */
const RUNNER_NETWORK_MARGIN_MS = 20;

interface ActResponse {
  action: unknown;
  error: string | null;
  timedOut: boolean;
  late: boolean;
  disabled: boolean;
  logs: BotLogLine[];
  durationMs: number;
}

export class RunnerUnavailableError extends Error {
  constructor(message = 'The bot runner is unavailable. Please try again shortly.') {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

export class BotRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotRejectedError';
  }
}

/** HTTP client for the internal bot-runner service. */
export class RunnerClient implements BotExecutor {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authorization = `Bearer ${token}`;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(5000);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RunnerUnavailableError();
    }
  }

  async validate(source: string): Promise<ValidationResult> {
    const response = await this.call('POST', '/v1/validate', { source });
    if (!response.ok) throw new RunnerUnavailableError();
    const result = (await response.json()) as { ok: boolean; error?: string };
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? 'Your bot failed to load' };
  }

  async createSession(source: string, seed: number): Promise<SandboxSession> {
    const response = await this.call('POST', '/v1/sessions', { source, seed });
    const body = (await response.json().catch(() => ({}))) as {
      sessionId?: string;
      error?: string;
    };
    if (response.status === 422) throw new BotRejectedError(body.error ?? 'Bot failed to load');
    if (!response.ok || !body.sessionId) throw new RunnerUnavailableError(body.error);
    const sessionId = body.sessionId;
    let disabled = false;
    return {
      decide: async (observation: Observation, signal: AbortSignal, budgetMs: number) => {
        if (disabled) return null;
        const result = await this.call(
          'POST',
          `/v1/sessions/${sessionId}/act`,
          { observation, budgetMs: Math.max(10, budgetMs - RUNNER_NETWORK_MARGIN_MS) },
          signal,
        );
        if (!result.ok) throw new RunnerUnavailableError();
        const act = (await result.json()) as ActResponse;
        if (act.disabled) disabled = true;
        if (act.error) throw new Error(act.error);
        return act.action;
      },
      dispose: async () => {
        await this.call('DELETE', `/v1/sessions/${sessionId}`).catch(() => undefined);
      },
    };
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
