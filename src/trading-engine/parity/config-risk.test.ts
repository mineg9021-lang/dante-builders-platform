import { DEFAULT_PARITY_CONFIG, validateParityConfig } from './config';
import { evaluateParityRisk } from './risk-controller';

describe('PRIME parity configuration', () => {
    it('accepts the bounded one-tick baseline', () => {
        expect(validateParityConfig(DEFAULT_PARITY_CONFIG)).toEqual({ valid: true, errors: [] });
    });
    it('rejects unsupported contracts-by-proxy settings and unsafe exposure', () => {
        const result = validateParityConfig({ ...DEFAULT_PARITY_CONFIG, symbol: 'R_10', maxStakePercent: 5, durationTicks: 5 as 1 });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('STAKE_EXPOSURE_LIMIT_EXCEEDED');
        expect(result.errors).toContain('PARITY_DURATION_MUST_BE_ONE_TICK');
    });
});

describe('PRIME parity risk controller', () => {
    const base = {
        authorized: true, isVirtual: true, mode: 'demo' as const, stake: 1, balance: 100,
        maxStakePercent: 2, sessionProfit: 0, sessionLoss: 0, stopLoss: 5, takeProfit: 5,
        tradesThisSession: 0, maxTradesPerSession: 10, consecutiveLosses: 0,
        maxConsecutiveLosses: 3, activeContracts: 0, maxActiveContracts: 1, cooldownUntil: 0, now: 1000,
    };
    it('allows a valid demo risk snapshot', () => expect(evaluateParityRisk(base)).toEqual({ allowed: true, reasons: [] }));
    it('fails closed for an unresolved contract, exposure breach and analysis mode', () => {
        const result = evaluateParityRisk({ ...base, mode: 'analysis', activeContracts: 1, stake: 3 });
        expect(result.allowed).toBe(false);
        expect(result.reasons).toEqual(expect.arrayContaining(['ANALYSIS_ONLY_MODE', 'ACTIVE_CONTRACT_LIMIT_REACHED', 'ACCOUNT_EXPOSURE_LIMIT']));
    });
});
