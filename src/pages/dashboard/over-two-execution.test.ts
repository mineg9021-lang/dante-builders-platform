import { executeOverTwoContract, type OverTwoApi } from './over-two-execution';

const makeApi = (available = ['DIGITOVER']) => {
    const send = jest.fn(async (request: Record<string, unknown>) => {
        if (request.contracts_for) return { contracts_for: { available: available.map(contract_type => ({ contract_type })) } };
        if (request.proposal) return { proposal: { id: 'proposal-1', ask_price: 1 } };
        if (request.buy) return { buy: { contract_id: 456 } };
        if (request.proposal_open_contract) return {
            subscription: { id: 'sub-1' },
            proposal_open_contract: { contract_id: 456, status: 'won', profit: 0.5, is_sold: 1 },
        };
        if (request.forget) return {};
        return {};
    });
    const api = {
        send,
        onMessage: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
    } as unknown as OverTwoApi;
    return { api, send };
};

const input = (api: OverTwoApi) => ({
    api, symbol: 'R_100', stake: 1, currency: 'USD', mode: 'demo' as const,
    executionPermission: true, authorized: true, isVirtual: true,
    lastTickEpoch: Date.now() / 1000, shouldContinue: () => true,
});

describe('Over 2 Deriv execution', () => {
    it('discovers DIGITOVER, requests barrier 2, buys once and verifies settlement', async () => {
        const { api, send } = makeApi();
        const result = await executeOverTwoContract(input(api));
        const proposal = send.mock.calls.find(([request]) => request.proposal);
        expect(proposal?.[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', underlying_symbol: 'R_100' });
        expect(result).toMatchObject({ contractId: 456, settlement: 'WON', profit: 0.5 });
        expect(send.mock.calls.filter(([request]) => request.buy)).toHaveLength(1);
    });

    it('blocks unsupported contracts before proposal or purchase', async () => {
        const { api, send } = makeApi(['DIGITDIFF']);
        await expect(executeOverTwoContract(input(api))).rejects.toThrow('DIGITOVER is not currently available');
        expect(send.mock.calls.some(([request]) => request.proposal || request.buy)).toBe(false);
    });

    it('blocks execution without explicit authorisation', async () => {
        const { api, send } = makeApi();
        await expect(executeOverTwoContract({ ...input(api), executionPermission: false })).rejects.toThrow('not authorised');
        expect(send).not.toHaveBeenCalled();
    });
});
