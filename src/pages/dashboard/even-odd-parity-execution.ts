import { validateSettlement } from './even-odd-parity-engine';

export type ParityContractType = 'DIGITEVEN' | 'DIGITODD';
export type ParityTradeMode = 'analysis' | 'demo' | 'live';

type DerivMessageSubscription = { unsubscribe: () => void };
export type DerivParityApi = {
    send: (request: Record<string, unknown>) => Promise<any>;
    onMessage: () => { subscribe: (callback: (message: any) => void) => DerivMessageSubscription };
};

export type ParityExecutionInput = {
    api: DerivParityApi;
    symbol: string;
    contractType: ParityContractType;
    stake: number;
    currency: string;
    mode: ParityTradeMode;
    executionPermission: boolean;
    authorized: boolean;
    isVirtual: boolean;
    timeoutMs?: number;
};

export type ParityExecutionResult = {
    contractId: number;
    contractType: ParityContractType;
    symbol: string;
    buyPrice: number;
    settlement: 'WON' | 'LOST' | 'VOID';
    profit: number;
};

const getApiError = (response: any) => response?.error?.message || response?.error?.code || null;
const isTerminalContract = (contract: any) => {
    const status = String(contract?.status || '').toLowerCase();
    return ['won', 'lost', 'sold', 'void'].includes(status) ||
        contract?.is_sold === 1 || contract?.is_expired === 1;
};

/**
 * Execute one fixed-stake parity contract after the caller's full safety pipeline
 * has granted permission. No retry, progression, martingale or automatic re-entry.
 */
export const executeParityContract = async (input: ParityExecutionInput): Promise<ParityExecutionResult> => {
    if (input.mode === 'analysis') throw new Error('Analysis mode cannot place orders.');
    if (!input.executionPermission || !input.authorized) throw new Error('Execution safety gate is not authorized.');
    if (input.mode === 'demo' && !input.isVirtual) throw new Error('Demo mode requires a Deriv demo account.');
    if (input.mode === 'live' && input.isVirtual) throw new Error('Live mode requires a Deriv real account.');
    if (!input.symbol || !input.currency) throw new Error('A valid market and account currency are required.');
    if (!Number.isFinite(input.stake) || input.stake <= 0) throw new Error('Stake must be a positive number.');
    if (!['DIGITEVEN', 'DIGITODD'].includes(input.contractType)) throw new Error('Unsupported parity contract type.');

    const proposalResponse = await input.api.send({
        proposal: 1,
        amount: input.stake,
        basis: 'stake',
        contract_type: input.contractType,
        currency: input.currency,
        duration: 1,
        duration_unit: 't',
        underlying_symbol: input.symbol,
    });
    const proposalError = getApiError(proposalResponse);
    if (proposalError) throw new Error(`Deriv proposal rejected: ${proposalError}`);

    const proposal = proposalResponse?.proposal;
    const proposalId = String(proposal?.id || '');
    const askPrice = Number(proposal?.ask_price);
    if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0 || askPrice > input.stake + 0.0000001) {
        throw new Error('Deriv returned an invalid proposal or a price above the configured stake.');
    }

    const buyResponse = await input.api.send({ buy: proposalId, price: askPrice });
    const buyError = getApiError(buyResponse);
    if (buyError) throw new Error(`Deriv purchase rejected: ${buyError}`);

    const contractId = Number(buyResponse?.buy?.contract_id);
    if (!Number.isSafeInteger(contractId) || contractId <= 0) {
        throw new Error('Deriv did not return a valid contract ID after purchase.');
    }

    const settlement = await monitorParityContract(input.api, contractId, input.timeoutMs ?? 90_000);
    const verified = validateSettlement(settlement);
    if (!verified) throw new Error('Contract monitoring ended without a verified settlement result.');

    return {
        contractId,
        contractType: input.contractType,
        symbol: input.symbol,
        buyPrice: askPrice,
        settlement: verified.status,
        profit: verified.profit,
    };
};

export const monitorParityContract = (
    api: DerivParityApi,
    contractId: number,
    timeoutMs = 90_000
): Promise<{ status?: string; profit?: number | string }> =>
    new Promise((resolve, reject) => {
        let completed = false;
        let subscriptionId: string | undefined;
        const messageSubscription = api.onMessage().subscribe(message => {
            if (Number(message?.proposal_open_contract?.contract_id) !== contractId) return;
            const contract = message.proposal_open_contract;
            if (isTerminalContract(contract)) finish(contract);
        });

        const cleanup = () => {
            window.clearTimeout(timeout);
            messageSubscription.unsubscribe();
            if (subscriptionId) {
                void api.send({ forget: subscriptionId }).catch(() => undefined);
            }
        };

        const finish = (contract: { status?: string; profit?: number | string }) => {
            if (completed) return;
            completed = true;
            cleanup();
            resolve(contract);
        };

        const timeout = window.setTimeout(() => {
            if (completed) return;
            completed = true;
            cleanup();
            reject(new Error('Contract settlement monitoring timed out. Trading has been paused.'));
        }, timeoutMs);

        api.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
            .then(response => {
                if (completed) return;
                const error = getApiError(response);
                if (error) {
                    completed = true;
                    cleanup();
                    reject(new Error(`Contract monitoring failed: ${error}`));
                    return;
                }
                subscriptionId = response?.subscription?.id;
                const contract = response?.proposal_open_contract;
                if (contract && isTerminalContract(contract)) finish(contract);
            })
            .catch(error => {
                if (completed) return;
                completed = true;
                cleanup();
                reject(error instanceof Error ? error : new Error('Contract monitoring failed.'));
            });
    });
