import { executeDerivBulk } from './bulk-execution';
import type { DerivTradingApi, ExecutionRiskContext } from './execution';

const makeApi = () => {
    let proposalNumber = 0;
    let contractNumber = 500;
    const send = jest.fn(async (request: Record<string, any>) => {
        if (request.contracts_for) return { contracts_for: { available: [{ contract_type: 'DIGITOVER' }] } };
        if (request.proposal) return { proposal: { id: 'proposal-' + (++proposalNumber), ask_price: 1 } };
        if (request.buy) return { buy: { contract_id: ++contractNumber } };
        if (request.proposal_open_contract) return {
            proposal_open_contract: { contract_id: request.contract_id, status: 'won', profit: 0.5 },
        };
        return {};
    });
    const api = {
        send,
        onMessage: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
    } as unknown as DerivTradingApi;
    return { api, send };
};

const risk = (overrides: Partial<ExecutionRiskContext> = {}): ExecutionRiskContext => ({
    mode: 'demo', authorized: true, isVirtual: true, liveTradingConfirmed: false,
    strategyDecision: 'READY', lastTickEpoch: Date.now() / 1000,
    stake: 1, balance: 100, maxStake: 1, maxStakePercent: 2,
    sessionPnl: 0, stopLoss: 20, takeProfit: 20, tradesThisSession: 0, maxTradesPerSession: 20,
    ...overrides,
});

describe('signal-gated Deriv bulk execution', () => {
    it('prepares all proposals, dispatches the configured purchases, and verifies each settlement', async () => {
        const { api, send } = makeApi();
        const purchased = jest.fn();
        const settled = jest.fn();
        const results = await executeDerivBulk({
            api, symbol: 'R_100', contractType: 'DIGITOVER', currency: 'USD',
            proposalFields: { duration: 1, duration_unit: 't', barrier: '3' },
            risk: risk({ balance: 200 }), runs: 3, idempotencyKey: 'bulk-signal-1',
            onPurchased: purchased, onSettled: settled,
        });
        expect(send.mock.calls.filter(([request]) => request.proposal)).toHaveLength(3);
        expect(send.mock.calls.filter(([request]) => request.buy)).toHaveLength(3);
        expect(results).toHaveLength(3);
        expect(results.every(result => result.settlement === 'WON')).toBe(true);
        expect(purchased).toHaveBeenCalledTimes(3);
        expect(settled).toHaveBeenCalledTimes(3);
    });

    it('rejects the entire batch before buying when aggregate exposure is above the cap', async () => {
        const { api, send } = makeApi();
        await expect(executeDerivBulk({
            api, symbol: 'R_100', contractType: 'DIGITOVER', currency: 'USD',
            proposalFields: { duration: 1, duration_unit: 't', barrier: '3' },
            risk: risk({ balance: 100, maxStakePercent: 2 }), runs: 3,
            idempotencyKey: 'bulk-over-cap',
        })).rejects.toThrow('BULK_TOTAL_EXPOSURE_LIMIT');
        expect(send).not.toHaveBeenCalled();
    });

    it('rejects a batch that would exceed the configured session trade limit', async () => {
        const { api, send } = makeApi();
        await expect(executeDerivBulk({
            api, symbol: 'R_100', contractType: 'DIGITOVER', currency: 'USD',
            proposalFields: { duration: 1, duration_unit: 't', barrier: '3' },
            risk: risk({ tradesThisSession: 9, maxTradesPerSession: 10 }), runs: 2,
            idempotencyKey: 'bulk-session-limit',
        })).rejects.toThrow('BULK_EXCEEDS_SESSION_TRADE_LIMIT');
        expect(send).not.toHaveBeenCalled();
    });

    it('does not buy when any prepared proposal is invalid', async () => {
        const { api, send } = makeApi();
        send.mockImplementation(async (request: Record<string, any>) => {
            if (request.contracts_for) return { contracts_for: { available: [{ contract_type: 'DIGITOVER' }] } };
            if (request.proposal) return { proposal: { id: 'proposal', ask_price: 5 } };
            return {};
        });
        await expect(executeDerivBulk({
            api, symbol: 'R_100', contractType: 'DIGITOVER', currency: 'USD',
            proposalFields: { duration: 1, duration_unit: 't', barrier: '3' },
            risk: risk(), runs: 2, idempotencyKey: 'bulk-invalid-proposal',
        })).rejects.toThrow('BULK_INVALID_OR_OVER_LIMIT_PROPOSAL');
        expect(send.mock.calls.some(([request]) => request.buy)).toBe(false);
    });
});
