export type DerivTickPayload = { symbol: string; quote: string | number; epoch: number; pip_size: number };
export type ProcessedParityTick = { symbol: string; quote: string; epoch: number; precision: number; digit: number; parity: 'EVEN' | 'ODD' };

/** Preserve the quote's decimal representation; never use Number/rounding to find its final digit. */
export const normalizeDerivQuote = (quote: string | number, precision: number): string | null => {
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) return null;
    const source = String(quote).trim();
    if (!/^[+-]?\\d+(?:\\.\\d+)?$/.test(source)) return null;
    const [whole, fraction = ''] = source.split('.');
    if (fraction.length > precision) return null;
    return precision === 0 ? whole : whole + '.' + fraction.padEnd(precision, '0');
};

export const extractFinalDigit = (quote: string, precision: number): number | null => {
    const normalized = normalizeDerivQuote(quote, precision);
    if (normalized === null) return null;
    const digit = precision > 0 ? normalized.split('.')[1]?.[precision - 1] : normalized.replace(/\\D/g, '').slice(-1);
    if (!digit || !/\\d/.test(digit)) return null;
    return Number(digit);
};

export const processDerivTick = (tick: DerivTickPayload): ProcessedParityTick | null => {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(tick.symbol) || !Number.isFinite(tick.epoch) || tick.epoch <= 0) return null;
    const quote = normalizeDerivQuote(tick.quote, tick.pip_size);
    if (quote === null) return null;
    const digit = extractFinalDigit(quote, tick.pip_size);
    if (digit === null) return null;
    return { symbol: tick.symbol, quote, epoch: tick.epoch, precision: tick.pip_size, digit, parity: digit % 2 === 0 ? 'EVEN' : 'ODD' };
};
