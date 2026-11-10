export const DANTE_VOLATILITY_SYMBOLS = [
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
] as const;

export type DanteVolatilitySymbol = (typeof DANTE_VOLATILITY_SYMBOLS)[number];

export const isDanteVolatilitySymbol = (symbol: unknown): symbol is DanteVolatilitySymbol =>
    typeof symbol === 'string' && DANTE_VOLATILITY_SYMBOLS.includes(symbol as DanteVolatilitySymbol);
