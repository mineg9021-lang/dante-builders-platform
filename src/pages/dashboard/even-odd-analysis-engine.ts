export type ValidatedTick = {
    symbol: string;
    quote: string;
    epoch: number;
    digit: number;
    parity: 'EVEN' | 'ODD';
};

export type TickValidation = {
    accepted: boolean;
    reason?: 'INVALID_SYMBOL' | 'INVALID_QUOTE' | 'INVALID_EPOCH' | 'DUPLICATE_OR_OUT_OF_ORDER' | 'STALE_TICK';
    tick?: ValidatedTick;
};

export type ParityAnalysis = {
    sampleSize: number;
    evenCount: number;
    oddCount: number;
    evenRate: number;
    oddRate: number;
    lead: 'EVEN' | 'ODD' | 'NONE';
    decision: 'WAIT' | 'CANDIDATE';
    evidenceScore: number;
};

export const MAX_TICK_AGE_SECONDS = 15;
export const MIN_ANALYSIS_SAMPLE = 30;
export const MIN_PARITY_LEAD = 0.12;

export const extractLastDigit = (quote: number | string, precision: number): number | null => {
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) return null;
    if (typeof quote === 'number' && !Number.isFinite(quote)) return null;

    const source = typeof quote === 'number' ? quote.toFixed(precision) : quote.trim();
    if (!/^[-+]?\d+(?:\.\d+)?$/.test(source)) return null;

    const decimal = source.split('.')[1] || '';
    const normalized = precision > 0 ? decimal.padEnd(precision, '0').slice(0, precision) : source.split('.')[0];
    const digit = normalized.length ? Number(normalized[normalized.length - 1]) : Number(source.replace(/\D/g, '').slice(-1));
    return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : null;
};

export const validateTick = (
    symbol: string,
    quote: number | string,
    epoch: number,
    precision: number,
    previousEpoch: number | undefined,
    nowSeconds = Date.now() / 1000
): TickValidation => {
    if (!symbol) return { accepted: false, reason: 'INVALID_SYMBOL' };
    const digit = extractLastDigit(quote, precision);
    if (digit === null) return { accepted: false, reason: 'INVALID_QUOTE' };
    if (!Number.isFinite(epoch) || epoch <= 0) return { accepted: false, reason: 'INVALID_EPOCH' };
    if (previousEpoch !== undefined && epoch <= previousEpoch) {
        return { accepted: false, reason: 'DUPLICATE_OR_OUT_OF_ORDER' };
    }
    if (nowSeconds - epoch > MAX_TICK_AGE_SECONDS || epoch - nowSeconds > 5) {
        return { accepted: false, reason: 'STALE_TICK' };
    }

    const parity = digit % 2 === 0 ? 'EVEN' : 'ODD';
    return {
        accepted: true,
        tick: {
            symbol,
            quote: typeof quote === 'number' ? quote.toFixed(precision) : String(quote),
            epoch,
            digit,
            parity,
        },
    };
};

/**
 * Describes the observed sample only. It is not a forecast of the next tick
 * and must never be used as a standalone purchase authorization.
 */
export const analyseParity = (digits: number[]): ParityAnalysis => {
    const validDigits = digits.filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);
    const sampleSize = validDigits.length;
    const evenCount = validDigits.filter(digit => digit % 2 === 0).length;
    const oddCount = sampleSize - evenCount;
    const evenRate = sampleSize ? evenCount / sampleSize : 0;
    const oddRate = sampleSize ? oddCount / sampleSize : 0;
    const difference = Math.abs(evenRate - oddRate);
    const lead = evenCount === oddCount ? 'NONE' : evenCount > oddCount ? 'EVEN' : 'ODD';
    const decision = sampleSize >= MIN_ANALYSIS_SAMPLE && difference >= MIN_PARITY_LEAD ? 'CANDIDATE' : 'WAIT';

    return {
        sampleSize,
        evenCount,
        oddCount,
        evenRate,
        oddRate,
        lead,
        decision,
        evidenceScore: Math.round(difference * 100),
    };
};
