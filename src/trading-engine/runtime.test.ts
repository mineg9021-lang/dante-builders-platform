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
        })).rejects.toThrow('CONTRACT_NOT_AVAILABLE_FOR_CONFIGURED_MARKETS');
        expect(api.send).toHaveBeenCalledTimes(1);
    });

    it('pauses with a rejected decision when the analysis time limit expires without a signal', async () => {
        jest.useFakeTimers();
        try {
            let listener: ((message: any) => void) | undefined;
            const send = jest.fn()
                .mockResolvedValueOnce({ contracts_for: { available: [{ contract_type: 'DIGITEVEN' }] } })
                .mockResolvedValueOnce({ subscription: { id: 'ticks-sub' } });
            const onDecision = jest.fn();
            const api: DerivTradingApi = {
                send,
                onMessage: () => ({ subscribe: callback => {
                    listener = callback;
                    return { unsubscribe: jest.fn() };
                } }),
            };
            const runtime = await startStrategyRuntime({
                api,
                symbol: 'R_100',
                precision: 2,
                strategy: { id: 'EVEN' },
                currency: 'USD',
                analysisMaxDurationMs: 10000,
                risk: {
                    mode: 'demo', authorized: true, isVirtual: true, liveTradingConfirmed: false,
                    stake: 1, balance: 100, maxStake: 5, maxStakePercent: 2,
                    sessionPnl: 0, stopLoss: 10, takeProfit: 10,
                    tradesThisSession: 0, maxTradesPerSession: 10,
                },
                onDecision,
            });
            jest.advanceTimersByTime(10000);
            expect(runtime.getStatus()).toBe('PAUSED_ERROR');
            expect(onDecision).toHaveBeenLastCalledWith(expect.objectContaining({
                decision: 'REJECTED',
                reason: 'ANALYSIS_TIME_LIMIT_REACHED',
            }));
            expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ proposal: 1 }));
            expect(listener).toBeDefined();
        } finally {
            jest.useRealTimers();
        }
    });

    it('pauses after the configured tick limit and never buys an incomplete sample', async () => {
        jest.useFakeTimers();
        try {
            let listener: ((message: any) => void) | undefined;
            const send = jest.fn()
                .mockResolvedValueOnce({ contracts_for: { available: [{ contract_type: 'DIGITEVEN' }] } })
                .mockResolvedValueOnce({ subscription: { id: 'ticks-sub' } });
            const onDecision = jest.fn();
            const api: DerivTradingApi = {
                send,
                onMessage: () => ({ subscribe: callback => {
                    listener = callback;
                    return { unsubscribe: jest.fn() };
                } }),
            };
            const runtime = await startStrategyRuntime({
                api,
                symbol: 'R_100',
                precision: 2,
                strategy: { id: 'EVEN' },
                currency: 'USD',
                analysisMaxTicks: 5,
                analysisMaxDurationMs: 60000,
                risk: {
                    mode: 'demo', authorized: true, isVirtual: true, liveTradingConfirmed: false,
                    stake: 1, balance: 100, maxStake: 5, maxStakePercent: 2,
                    sessionPnl: 0, stopLoss: 10, takeProfit: 10,
                    tradesThisSession: 0, maxTradesPerSession: 10,
                },
                onDecision,
            });
            const epoch = Math.floor(Date.now() / 1000);
            for (let index = 0; index < 5; index += 1) {
                listener?.({ msg_type: 'tick', tick: {
                    symbol: 'R_100', quote: (100 + index / 100).toFixed(2), epoch: epoch + index,
                } });
            }
            expect(runtime.getStatus()).toBe('PAUSED_ERROR');
            expect(onDecision).toHaveBeenLastCalledWith(expect.objectContaining({
                decision: 'REJECTED',
                reason: 'ANALYSIS_TICK_LIMIT_REACHED',
            }));
            expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ proposal: 1 }));
        } finally {
            jest.useRealTimers();
        }
    });

});
