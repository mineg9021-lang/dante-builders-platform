import { buildProposalRequest, validateExecutionRisk } from './execution';
import type { ExecutionRiskContext } from './execution';

const risk = (overrides: Partial<ExecutionRiskContext> = {}): ExecutionRiskContext => ({
    mode: 'demo',
    authorized: true,
    isVirtual: true,
    liveTradingConfirmed: false,
    strategyDecision: 'READY',
    lastTickEpoch: 1_800_000_000,
    nowSeconds: 1_800_000_000,
    stake: 1,
    balance: 100,
    maxStake: 5,
    maxStakePercent: 2,
    sessionPnl: 0,
    stopLoss: 10,
    takeProfit: 10,
    tradesThisSession: 0,
    maxTradesPerSession: 10,
    ...overrides,
});

describe('shared Deriv execution guards', () => {
    it('allows a fresh authorised demo opportunity within risk limits', () => {
        expect(validateExecutionRisk(risk(), 1_800_000_000)).toBeNull();
    });

    it('rejects live execution without explicit live confirmation', () => {
        expect(validateExecutionRisk(risk({
            mode: 'live',
            isVirtual: false,
            liveTradingConfirmed: false,
        }), 1_800_000_000)).toBe('LIVE_TRADING_NOT_CONFIRMED');
    });

    it('rejects stale ticks and a strategy that is not READY', () => {
        expect(validateExecutionRisk(risk({ lastTickEpoch: 1_799_999_900 }), 1_800_000_000)).toBe('ENTRY_TICK_STALE');
        expect(validateExecutionRisk(risk({ strategyDecision: 'WAIT' }), 1_800_000_000)).toBe('STRATEGY_NOT_READY');
    });

    it('rejects exposure above the configured balance percentage', () => {
        expect(validateExecutionRisk(risk({ stake: 3 }), 1_800_000_000)).toBe('STAKE_EXPOSURE_LIMIT');
    });

    it('builds a proposal using only recognised Deriv proposal fields', () => {
        expect(buildProposalRequest({
            symbol: 'R_100',
            contractType: 'RUNHIGH',
            currency: 'USD',
            risk: risk(),
            proposalFields: { duration: 5, duration_unit: 't', prediction: 4, ignored: 'nope' } as any,
        })).toEqual({
            proposal: 1,
            amount: 1,
            basis: 'stake',
            contract_type: 'RUNHIGH',
            currency: 'USD',
            underlying_symbol: 'R_100',
            duration: 5,
            duration_unit: 't',
            prediction: 4,
        });
    });
});
