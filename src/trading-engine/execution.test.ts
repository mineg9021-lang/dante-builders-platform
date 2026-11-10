import { buildProposalRequest, executeDerivContract, monitorDerivContract, validateExecutionRisk } from './execution';
import type { DerivTradingApi, ExecutionRiskContext, ExecuteDerivContractInput } from './execution';

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

const executionInput = (
    api: DerivTradingApi,
    overrides: Partial<ExecuteDerivContractInput> = {}
): ExecuteDerivContractInput => ({
    api,
    symbol: 'R_100',
    contractType: 'DIGITEVEN',
    currency: 'USD',
    proposalFields: { duration: 1, duration_unit: 't' },
    risk: risk({ lastTickEpoch: Date.now() / 1000, nowSeconds: Date.now() / 1000 }),
    idempotencyKey: 'test-opportunity-' + Math.random().toString(36).slice(2),
    settlementTimeoutMs: 50,
    ...overrides,
});

const successfulApi = (settlement: 'won' | 'lost' | 'void' | 'sold' = 'won') => {
    const send = jest.fn(async (request: Record<string, unknown>) => {
        if (request.contracts_for) {
            return { contracts_for: { available: [{ contract_type: 'DIGITEVEN', underlying_symbol: 'R_100' }] } };
        }
        if (request.proposal) return { proposal: { id: 'proposal-1', ask_price: 1 } };
        if (request.buy) return { buy: { contract_id: 12345 } };
        if (request.proposal_open_contract) {
            return { proposal_open_contract: {
                contract_id: 12345, status: settlement, profit: settlement === 'won' ? 0.95 : -1,
                is_sold: settlement === 'sold' ? 1 : 0, is_expired: settlement === 'void' ? 1 : 0,
            } };
        }
        return {};
    });
    const api: DerivTradingApi = {
        send,
        onMessage: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
    };
    return { api, send };
};

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
        });
    });
});

describe('shared Deriv proposal, purchase and settlement pipeline', () => {
    it('checks market contract availability before requesting a proposal', async () => {
        const { api, send } = successfulApi();
        send.mockImplementation(async request => {
            if (request.contracts_for) return { contracts_for: { available: [{ contract_type: 'CALL' }] } };
            return {};
        });

        await expect(executeDerivContract(executionInput(api))).rejects.toThrow('CONTRACT_NOT_AVAILABLE_FOR_SYMBOL');
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ proposal: 1 }));
    });

    it('sends the proposal, buys the returned proposal ID once, and verifies settlement', async () => {
        const { api, send } = successfulApi('won');
        const onPurchased = jest.fn();
        const result = await executeDerivContract(executionInput(api, { onPurchased }));

        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
            proposal: 1, contract_type: 'DIGITEVEN', underlying_symbol: 'R_100',
        }));
        expect(send).toHaveBeenNthCalledWith(3, { buy: 'proposal-1', price: 1 });
        expect(onPurchased).toHaveBeenCalledWith({
            contractId: 12345, buyPrice: 1, symbol: 'R_100', contractType: 'DIGITEVEN',
        });
        expect(result).toEqual(expect.objectContaining({
            contractId: 12345, settlement: 'WON', profit: 0.95,
        }));
        expect(send).toHaveBeenCalledTimes(4);
    });

    it.each([
        ['won', 'WON'],
        ['lost', 'LOST'],
        ['void', 'VOID'],
        ['sold', 'VOID'],
    ] as const)('maps Deriv terminal status %s to verified result %s', async (status, expected) => {
        const { api } = successfulApi(status);
        const result = await executeDerivContract(executionInput(api));
        expect(result.settlement).toBe(expected);
    });

    it('does not retry a purchase when the transport outcome is unknown', async () => {
        const { api, send } = successfulApi();
        send.mockImplementation(async request => {
            if (request.contracts_for) return { contracts_for: { available: [{ contract_type: 'DIGITEVEN' }] } };
            if (request.proposal) return { proposal: { id: 'proposal-uncertain', ask_price: 1 } };
            if (request.buy) throw new Error('connection lost');
            return {};
        });

        await expect(executeDerivContract(executionInput(api))).rejects.toThrow('PURCHASE_OUTCOME_UNKNOWN');
        expect(send.mock.calls.filter(([request]) => Boolean(request.buy))).toHaveLength(1);
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ proposal_open_contract: 1 }));
    });

    it('rejects a Deriv proposal error without attempting a purchase', async () => {
        const { api, send } = successfulApi();
        send.mockImplementation(async request => {
            if (request.contracts_for) return { contracts_for: { available: [{ contract_type: 'DIGITEVEN' }] } };
            if (request.proposal) return { error: { code: 'InvalidContract', message: 'Invalid contract' } };
            return {};
        });

        await expect(executeDerivContract(executionInput(api))).rejects.toThrow('PROPOSAL_REJECTED');
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ buy: expect.any(String) }));
    });

    it('rejects settlement monitoring when no terminal contract update arrives', async () => {
        jest.useFakeTimers();
        try {
            const api: DerivTradingApi = {
                send: jest.fn().mockResolvedValue({
                    proposal_open_contract: { contract_id: 12345, status: 'open', is_sold: 0, is_expired: 0 },
                    subscription: { id: 'open-contract-sub' },
                }),
                onMessage: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
            };
            const pending = monitorDerivContract(api, 12345, 1000);
            await Promise.resolve();
            await Promise.resolve();
            jest.advanceTimersByTime(1001);
            await expect(pending).rejects.toThrow('SETTLEMENT_MONITOR_TIMEOUT_RECONCILE_REQUIRED');
        } finally {
            jest.useRealTimers();
        }
    });
});
