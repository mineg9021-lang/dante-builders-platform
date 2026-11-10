import { startStrategyRuntime } from './runtime';
import type { DerivTradingApi } from './execution';

describe('strategy runtime safety', () => {
    it('refuses to start when Deriv does not offer the strategy contract for the selected symbol', async () => {
        const api: DerivTradingApi = {
            send: jest.fn().mockResolvedValue({ contracts_for: { available: [{ contract_type: 'PUT' }] } }),
            onMessage: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
        };
        await expect(startStrategyRuntime({
            api,
            symbol: 'R_100',
            precision: 2,
            strategy: { id: 'ONLY_UP' },
            currency: 'USD',
            risk: {
                mode: 'demo', authorized: true, isVirtual: true, liveTradingConfirmed: false,
                stake: 1, balance: 100, maxStake: 5, maxStakePercent: 2,
                sessionPnl: 0, stopLoss: 10, takeProfit: 10,
                tradesThisSession: 0, maxTradesPerSession: 10,
            },
        })).rejects.toThrow('CONTRACT_NOT_AVAILABLE_FOR_SELECTED_MARKET');
        expect(api.send).toHaveBeenCalledTimes(1);
    });
});
