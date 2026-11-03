import type { Currency, Money, MoneyWire } from '@adas/shared';

export const FX_SCALE = 1_000_000n;

/**
 * PRD §4.15 & AGENTS.md §7 — Money is { amountMinor: bigint, currency: 'USD' | 'CAD' },
 * serialized to JSON as integer strings. Zero floats are used.
 */
export function parseMoneyWire(wire: MoneyWire): Money {
  return {
    amountMinor: BigInt(wire.amountMinor),
    currency: wire.currency,
  };
}

export function toMoneyWire(money: Money): MoneyWire {
  return {
    amountMinor: money.amountMinor.toString(),
    currency: money.currency,
  };
}

/**
 * Converts minor units from one currency to another using an integer rateScaled (1_000_000 = 1.000000)
 * with half-up integer rounding.
 */
export function convertCurrencyMinor(
  amountMinor: bigint,
  fromCurrency: Currency,
  toCurrency: Currency,
  rateScaled: bigint,
): bigint {
  if (fromCurrency === toCurrency) {
    return amountMinor;
  }
  const numerator = amountMinor * rateScaled + FX_SCALE / 2n;
  return numerator / FX_SCALE;
}
