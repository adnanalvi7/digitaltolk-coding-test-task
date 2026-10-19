/** Shared unit constants, so conversions read as intent instead of magic numbers. */
export const MS_PER_SECOND = 1_000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_DAY = 86_400;
export const BYTES_PER_MEBIBYTE = 1_048_576;

export const secondsToMs = (seconds: number): number => seconds * MS_PER_SECOND;
export const msToSeconds = (ms: number): number => ms / MS_PER_SECOND;
