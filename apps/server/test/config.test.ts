import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://bomber@postgres:5432/bomber',
  RUNNER_TOKEN: '0123456789abcdef0123456789abcdef',
};

describe('loadConfig', () => {
  it('accepts a public origin given without a scheme, as hosting panels fill it', () => {
    const config = loadConfig({
      ...production,
      PUBLIC_ORIGIN: 'bomber.example.com',
      EXTRA_ORIGINS: 'www.example.com/',
    });
    expect(config.publicOrigin).toBe('https://bomber.example.com');
    expect(config.allowedOrigins).toEqual([
      'https://bomber.example.com',
      'https://www.example.com',
    ]);
    expect(config.cookieSecure).toBe(true);
  });

  it('keeps an explicit scheme and port', () => {
    const config = loadConfig({ ...production, PUBLIC_ORIGIN: 'http://10.0.0.5:8080/' });
    expect(config.publicOrigin).toBe('http://10.0.0.5:8080');
    expect(config.cookieSecure).toBe(false);
  });

  it('tolerates quotes and lists of domains', () => {
    expect(
      loadConfig({ ...production, PUBLIC_ORIGIN: '"https://a.example.com"' }).publicOrigin,
    ).toBe('https://a.example.com');
    expect(
      loadConfig({ ...production, PUBLIC_ORIGIN: 'https://a.example.com,https://b.example.com' })
        .publicOrigin,
    ).toBe('https://a.example.com');
  });

  it('explains what is missing or wrong in production, showing the public origin it got', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/RUNNER_TOKEN|DATABASE_URL/);
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: '' })).toThrow(
      /PUBLIC_ORIGIN: Required in production/,
    );
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: 'https://bad host' })).toThrow(
      /got "https:\/\/bad host"/,
    );
  });
});
