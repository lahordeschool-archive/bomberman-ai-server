/** Timestamps come back as `Date` from both drivers; the API always speaks ISO strings. */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}
