export type OverTwoApi = {
    send: (request: Record<string, unknown>) => Promise<any>;
    onMessage: () => { subscribe: (callback: (message: any) => void) => { unsubscribe: () => void } };
};
export type OverTwoTradeMode = 'analysis' | 'demo' | 'live';
export type OverTwoExecutionInput = {
    api: OverTwoApi;
    symbol: string;
    stake: number;
    currency: string;
    mode: OverTwoTradeMode;
    executionPermission: boolean;
    authorized: boolean;
    isVirtual: boolean;
    lastTickEpoch: number;
    shouldContinue?: () => boolean;
    onPurchased?: (purchase: { contractId: number; symbol: string; buyPrice: number; createdAt: number }) => void;
    timeoutMs?: number;
};
export type OverTwoExecutionResult = {
    contractId: number;
    symbol: string;
    buyPrice: number;
    settlement: 'WON' | 'LOST' | 'VOID';
    profit: number;
    settledAt: number;
};
const apiError = (response: any) => response?.error?.message || response?.error?.code || null;
const terminal = (contract: any) => ['won', 'lost', 'sold', 'void'].includes(String(contract?.status || '').toLowerCase()) ||
    contract?.is_sold === 1 || contract?.is_expired === 1;

export const executeOverTwoContract = async (input: OverTwoExecutionInput): Promise<OverTwoExecutionResult> => {
    if (input.mode === 'analysis' || !input.executionPermission || !input.authorized) throw new Error('Over 2 execution is not authorised.');
    if (input.mode === 'demo' && !input.isVirtual) throw new Error('Demo mode requires a Deriv virtual account.');
    if (input.mode === 'live' && input.isVirtual) throw new Error('Live mode requires a Deriv real account.');
    if (!input.symbol || !input.currency || !Number.isFinite(input.stake) || input.stake <= 0) throw new Error('Market, currency and positive stake are required.');
    if (input.shouldContinue && !input.shouldContinue()) throw new Error('Bot was stopped before contract discovery.');
    const age = Date.now() / 1000 - input.lastTickEpoch;
    if (!Number.isFinite(input.lastTickEpoch) || age > 15 || age < -5) throw new Error('The entry tick is stale; a new sample is required.');

    const contractResponse = await input.api.send({ contracts_for: input.symbol });
    const contractError = apiError(contractResponse);
    if (contractError) throw new Error('Deriv contract discovery failed: ' + contractError);
    const available = contractResponse?.contracts_for?.available;
    if (!Array.isArray(available) || !available.some((item: any) => item.contract_type === 'DIGITOVER')) {
        throw new Error('DIGITOVER is not currently available for this market.');
    }
    if (input.shouldContinue && !input.shouldContinue()) throw new Error('Bot was stopped before requesting a proposal.');

    const proposalResponse = await input.api.send({
        proposal: 1, amount: input.stake, basis: 'stake', contract_type: 'DIGITOVER',
        currency: input.currency, duration: 1, duration_unit: 't', barrier: '2',
        underlying_symbol: input.symbol,
    });
    const proposalError = apiError(proposalResponse);
    if (proposalError) throw new Error('Deriv proposal rejected: ' + proposalError);
    const proposal = proposalResponse?.proposal;
    const proposalId = String(proposal?.id || '');
    const askPrice = Number(proposal?.ask_price);
    if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0 || askPrice > input.stake + 0.0000001) {
        throw new Error('Deriv returned an invalid Over 2 proposal or a price above the configured stake.');
    }
    const proposalAge = Date.now() / 1000 - input.lastTickEpoch;
    if (proposalAge > 15 || proposalAge < -5 || (input.shouldContinue && !input.shouldContinue())) {
        throw new Error('Entry confirmation expired or bot stopped before purchase. No buy request was sent.');
    }

    const buyResponse = await input.api.send({ buy: proposalId, price: askPrice });
    const buyError = apiError(buyResponse);
    if (buyError) throw new Error('Deriv purchase rejected: ' + buyError);
    const contractId = Number(buyResponse?.buy?.contract_id);
    if (!Number.isSafeInteger(contractId) || contractId <= 0) throw new Error('Deriv did not return a valid contract ID.');
    input.onPurchased?.({ contractId, symbol: input.symbol, buyPrice: askPrice, createdAt: Date.now() });

    const settlement = await monitorOverTwoContract(input.api, contractId, input.timeoutMs ?? 90_000);
    const status = String(settlement?.status || '').toLowerCase();
    if (!['won', 'lost', 'sold', 'void'].includes(status) || !Number.isFinite(Number(settlement.profit))) {
        throw new Error('The contract did not return a verified terminal settlement.');
    }
    return {
        contractId, symbol: input.symbol, buyPrice: askPrice,
        settlement: status === 'won' ? 'WON' : status === 'lost' ? 'LOST' : 'VOID',
        profit: Number(settlement.profit), settledAt: Date.now(),
    };
};

export const monitorOverTwoContract = (api: OverTwoApi, contractId: number, timeoutMs = 90_000): Promise<{ status?: string; profit?: number | string }> =>
    new Promise((resolve, reject) => {
        let completed = false;
        let subscriptionId: string | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let messageSubscription: { unsubscribe: () => void } | undefined;
        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            messageSubscription?.unsubscribe();
            if (subscriptionId) void api.send({ forget: subscriptionId }).catch(() => undefined);
        };
        const finish = (contract: { status?: string; profit?: number | string }) => {
            if (completed) return;
            completed = true;
            cleanup();
            resolve(contract);
        };
        timeout = setTimeout(() => {
            if (completed) return;
            completed = true;
            cleanup();
            reject(new Error('Over 2 settlement monitoring timed out. Bot has been paused.'));
        }, timeoutMs);
        messageSubscription = api.onMessage().subscribe(message => {
            const contract = message?.proposal_open_contract;
            if (Number(contract?.contract_id) === contractId && terminal(contract)) finish(contract);
        });
        api.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }).then(response => {
            if (completed) {
                const lateId = response?.subscription?.id;
                if (lateId) void api.send({ forget: lateId }).catch(() => undefined);
                return;
            }
            const error = apiError(response);
            if (error) {
                completed = true;
                cleanup();
                reject(new Error('Over 2 contract monitoring failed: ' + error));
                return;
            }
            subscriptionId = response?.subscription?.id;
            const contract = response?.proposal_open_contract;
            if (contract && terminal(contract)) finish(contract);
        }).catch(error => {
            if (completed) return;
            completed = true;
            cleanup();
            reject(error instanceof Error ? error : new Error('Over 2 settlement monitoring failed.'));
        });
    });
