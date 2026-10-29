import type { Config } from '../config.ts';

/**
 * Fire-and-forget server-side PostHog capture. Never throws, never awaited by callers,
 * and times out quickly so it can't hold resources. Disabled when POSTHOG_KEY is unset.
 */
export function captureServerEvent(
  config: Pick<Config, 'posthog' | 'env'>,
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
): void {
  const posthog = config.posthog;
  if (!posthog || config.env === 'test') return;
  try {
    void fetch(`${posthog.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: posthog.key,
        event,
        distinct_id: distinctId,
        properties: { ...properties, $lib: 'bomber-arena-server' },
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  } catch {
    // Analytics must never affect the game.
  }
}
