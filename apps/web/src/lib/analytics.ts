import type { PostHog } from 'posthog-js';
import type { PublicUser } from '@bomberman/protocol';

/**
 * PostHog product analytics. Settings come from the server (`/api/config`, env
 * POSTHOG_KEY / POSTHOG_HOST) so Coolify can change them without a rebuild.
 * Every function here swallows errors: analytics must never break the app.
 */
let client: PostHog | null = null;
let pending: Promise<PostHog | null> | null = null;
let currentUserId: string | null = null;

function load(): Promise<PostHog | null> {
  pending ??= (async () => {
    try {
      const response = await fetch('/api/config', { credentials: 'same-origin' });
      if (!response.ok) return null;
      const { posthog: settings } = (await response.json()) as {
        posthog: { key: string; host: string } | null;
      };
      if (!settings?.key) return null;
      const { default: posthog } = await import('posthog-js');
      posthog.init(settings.key, {
        api_host: settings.host,
        defaults: '2025-05-24',
        capture_pageview: 'history_change',
        autocapture: true,
        person_profiles: 'identified_only',
        disable_session_recording: false,
        session_recording: { maskAllInputs: true },
        disable_surveys: true,
      });
      client = posthog;
      return posthog;
    } catch {
      return null;
    }
  })();
  return pending;
}

export function initAnalytics(): void {
  void load();
}

export function capture(event: string, properties?: Record<string, unknown>): void {
  void load().then((posthog) => {
    try {
      posthog?.capture(event, properties);
    } catch {
      // ignore
    }
  });
}

/** Links events to the logged-in account (stable id + username, never the email). */
export function identifyUser(user: PublicUser | null): void {
  void load().then((posthog) => {
    try {
      if (!posthog) return;
      if (user) {
        if (currentUserId === user.id) return;
        currentUserId = user.id;
        posthog.identify(user.id, {
          username: user.username,
          name: user.displayName,
          role: user.role,
        });
      } else if (currentUserId) {
        currentUserId = null;
        posthog.reset();
      }
    } catch {
      // ignore
    }
  });
}

export const analyticsClient = () => client;
