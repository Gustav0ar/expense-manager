/**
 * Product ceiling for one monetary value, in cents.
 *
 * One billion currency units covers self-hosted expense data while remaining
 * about 90,000 times below Number.MAX_SAFE_INTEGER. Keep every persisted money
 * column on this same boundary so bigint values remain exact when Drizzle maps
 * them to JavaScript numbers.
 */
export const maxMoneyCents = 100_000_000_000;

export const amountExceedsMaximumMessage = 'Amount exceeds the maximum allowed.';
