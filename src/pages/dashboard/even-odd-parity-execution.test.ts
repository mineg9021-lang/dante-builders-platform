import { executeParityContract, type DerivParityApi } from './even-odd-parity-execution';

describe('guarded parity contract execution', () => {
    it('never sends a request in analysis mode', async () => {
        const api = { send: jest.fn(), onMessage: jest.fn() } as unknown as DerivParityApi;
        await expect(executeParityContract({
            api,
            symbol: 'R_10',
            contractType: 'DIGITEVEN',
            stake: 1,
            currency: 'USD',
            mode: 'analysis',
            executionPermission: true,
            authorized: true,
            isVirtual: true,
            lastTickEpoch: Math.floor(Date.now() / 1000),
        })).rejects.toThrow('Analysis mode cannot place orders.');
        expect(api.send).not.toHaveBeenCalled();
    });

    it('blocks demo orders on a real account and live orders on a demo account', async () => {
        const api = { send: jest.fn(), onMessage: jest.fn() } as unknown as DerivParityApi;
        const base = {
            api,
            symbol: 'R_10',
            contractType: 'DIGITEVEN' as const,
            stake: 1,
            currency: 'USD',
            executionPermission: true,
            authorized: true,
            lastTickEpoch: Math.floor(Date.now() / 1000),
        };
        await expect(executeParityContract({ ...base, mode: 'demo', isVirtual: false }))
            .rejects.toThrow('Demo mode requires a Deriv demo account.');
        await expect(executeParityContract({ ...base, mode: 'live', isVirtual: true }))
            .rejects.toThrow('Live mode requires a Deriv real account.');
        expect(api.send).not.toHaveBeenCalled();
    });

    it('requests a proposal, buys once, and validates the final settlement', async () => {
        const send = jest.fn()
            .mockResolvedValueOnce({ proposal: { id: 'proposal-1', ask_price: 1 } })
            .mockResolvedValueOnce({ buy: { contract_id: 12345 } })
            .mockResolvedValueOnce({
                proposal_open_contract: { contract_id: 12345, status: 'won', profit: '0.95' },
                subscription: { id: 'subscription-1' },
            })
            .mockResolvedValueOnce({});
        const unsubscribe = jest.fn();
        const api = {
            send,
            onMessage: () => ({ subscribe: () => ({ unsubscribe }) }),
        } as unknown as DerivParityApi;
        const onPurchased = jest.fn();

        const result = await executeParityContract({
            api,
            symbol: 'R_10',
            contractType: 'DIGITEVEN',
            stake: 1,
            currency: 'USD',
            mode: 'demo',
            executionPermission: true,
            authorized: true,
            isVirtual: true,
            lastTickEpoch: Math.floor(Date.now() / 1000),
            onPurchased,
            timeoutMs: 1000,
        });

        expect(result).toMatchObject({
            contractId: 12345,
            contractType: 'DIGITEVEN',
            symbol: 'R_10',
            buyPrice: 1,
            settlement: 'WON',
            profit: 0.95,
        });
        expect(result.settledAt).toEqual(expect.any(Number));
        expect(onPurchased).toHaveBeenCalledWith(expect.objectContaining({ contractId: 12345, contractType: 'DIGITEVEN' }));
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
            proposal: 1,
            contract_type: 'DIGITEVEN',
            duration: 1,
            duration_unit: 't',
            underlying_symbol: 'R_10',
        }));
        expect(send).toHaveBeenNthCalledWith(2, { buy: 'proposal-1', price: 1 });
        expect(send).toHaveBeenNthCalledWith(3, {
            proposal_open_contract: 1,
            contract_id: 12345,
            subscribe: 1,
        });
        expect(send).toHaveBeenNthCalledWith(4, { forget: 'subscription-1' });
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale entry tick before sending a proposal', async () => {
        const send = jest.fn();
        const api = { send, onMessage: jest.fn() } as unknown as DerivParityApi;
        await expect(executeParityContract({
            api,
            symbol: 'R_10',
            contractType: 'DIGITEVEN',
            stake: 1,
            currency: 'USD',
            mode: 'demo',
            executionPermission: true,
            authorized: true,
            isVirtual: true,
            lastTickEpoch: Math.floor(Date.now() / 1000) - 20,
        })).rejects.toThrow('Entry tick is stale; a fresh sample is required.');
        expect(send).not.toHaveBeenCalled();
    });

    it('honors a user disarm while a proposal request is in flight', async () => {
        const send = jest.fn().mockResolvedValueOnce({ proposal: { id: 'proposal-2', ask_price: 1 } });
        const api = { send, onMessage: jest.fn() } as unknown as DerivParityApi;
        const shouldContinue = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
        await expect(executeParityContract({
            api,
            symbol: 'R_10',
            contractType: 'DIGITODD',
            stake: 1,
            currency: 'USD',
            mode: 'demo',
            executionPermission: true,
            authorized: true,
            isVirtual: true,
            lastTickEpoch: Math.floor(Date.now() / 1000),
            shouldContinue,
        })).rejects.toThrow('Execution was disarmed before purchase. No buy request was sent.');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('rejects a proposal whose ask price exceeds the configured stake', async () => {
        const send = jest.fn().mockResolvedValueOnce({ proposal: { id: 'proposal-1', ask_price: 1.5 } });
        const api = { send, onMessage: jest.fn() } as unknown as DerivParityApi;
        await expect(executeParityContract({
            api,
            symbol: 'R_10',
            contractType: 'DIGITODD',
            stake: 1,
            currency: 'USD',
            mode: 'demo',
            executionPermission: true,
            authorized: true,
            isVirtual: true,
            lastTickEpoch: Math.floor(Date.now() / 1000),
        })).rejects.toThrow('Deriv returned an invalid proposal or a price above the configured stake.');
        expect(send).toHaveBeenCalledTimes(1);
    });
});
