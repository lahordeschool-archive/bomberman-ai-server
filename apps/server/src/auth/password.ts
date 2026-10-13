import { hash, verify } from '@node-rs/argon2';

/** `Algorithm.Argon2id`; the package exports it as an ambient const enum. */
const ARGON2ID = 2;

/** OWASP recommended Argon2id baseline: 19 MiB memory, 2 iterations, 1 lane. */
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password. Unknown users are checked against a throwaway hash so the
 * response time does not reveal which usernames exist.
 */
export async function verifyPassword(
  passwordHash: string | null,
  password: string,
): Promise<boolean> {
  if (!passwordHash || !passwordHash.startsWith('$argon2')) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(passwordHash, password).catch(() => false);
}
