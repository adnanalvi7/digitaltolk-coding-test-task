/** A non-null, non-array object whose own properties can be read safely. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `value[key]` only if it is a string; otherwise undefined. */
export function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

/** Reads `value[key]` only if it is a number; otherwise undefined. */
export function numberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === 'number' ? property : undefined;
}
