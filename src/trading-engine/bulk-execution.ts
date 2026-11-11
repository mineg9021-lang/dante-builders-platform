import {
    buildProposalRequest,
    monitorDerivContract,
    validateExecutionRisk,
    type DerivTradingApi,
    type ExecutionRiskContext,
    type VerifiedTradeResult,
} from './execution';
import { discoverContractsForSymbol, isContractAvailable, type DerivContractType } from './contracts';

export type DerivBulkExecutionInput = {
    api: DerivTradingApi;
    symbol: string;
    contractType: DerivContractType;
    currency: string;
    proposalFields: Record<string, unknown>;
    risk: ExecutionRiskContext;
    runs: number;
    idempotencyKey: string;
    shouldContinue?: () => boolean;
    onPurchased?: (purchase: { contractId: number; buyPrice: number; symbol: string; contractType: DerivContractType }) => void;
    onSettled?: (result: VerifiedTradeResult) => void;
    settlementTimeoutMs?: number;
};

const consumedBatches = new Set<string>();
const apiError = (response: any) => response?.error?.message || response?.error?.code || null;
const canContinue = (input: DerivBulkExecutionInput) => !input.shouldContinue || input.shouldContinue();

/**
 * A bulk run is one signal-gated batch. All proposals are validated before
 * any buy is sent; confirmed buys are dispatched together, never as blind
 * retries. Deriv/API latency is not guaranteed to be a fixed number of ms.
 */
export async function executeDerivBulk(input: DerivBulkExecutionInput): Promise<VerifiedTradeResult[]> {
    const count = input.runs;
    if (!Number.isInteger(count) || count < 2 || count > 20) throw new Error('BULK_RUN_COUNT_MUST_BE_2_TO_20');
    const riskError = validateExecutionRisk(input.risk);
    if (riskError) throw new Error(riskError);
    if (!input.idempotencyKey || consumedBatches.has(input.idempotencyKey)) throw new Error('DUPLICATE_BULK_SIGNAL_BLOCKED');
    if (input.risk.tradesThisSession + count > input.risk.maxTradesPerSession) throw new Error('BULK_EXCEEDS_SESSION_TRADE_LIMIT');
    if (input.risk.stake * count > input.risk.balance * input.risk.maxStakePercent / 100 ||
        input.risk.stake * count > input.risk.balance) throw new Error('BULK_TOTAL_EXPOSURE_LIMIT');
    if (!canContinue(input)) throw new Error('BULK_STOPPED_BEFORE_DISCOVERY');

    consumedBatches.add(input.idempotencyKey);
    const available = await discoverContractsForSymbol(input.api, input.symbol);
    if (!isContractAvailable(available, input.contractType)) throw new Error('CONTRACT_NOT_AVAILABLE_FOR_SYMBOL');
    if (!canContinue(input)) throw new Error('BULK_STOPPED_BEFORE_PROPOSALS');

    const proposalRequests = Array.from({ length: count }, () => buildProposalRequest({
        symbol: input.symbol,
        contractType: input.contractType,
        currency: input.currency,
        proposalFields: input.proposalFields,
        risk: input.risk,
    }));
    const proposalResults = await Promise.all(proposalRequests.map(request => input.api.send(request)));
    const proposals = proposalResults.map(response => {
        const error = apiError(response);
        if (error) throw new Error('BULK_PROPOSAL_REJECTED: ' + error);
        const proposal = response?.proposal;
        const id = String(proposal?.id || '');
        const askPrice = Number(proposal?.ask_price);
        if (!id || !Number.isFinite(askPrice) || askPrice <= 0 || askPrice > input.risk.stake) {
            throw new Error('BULK_INVALID_OR_OVER_LIMIT_PROPOSAL');
        }
        return { id, askPrice };
    });
    const aggregateAsk = proposals.reduce((sum, proposal) => sum + proposal.askPrice, 0);
    if (aggregateAsk > input.risk.balance * input.risk.maxStakePercent / 100 ||
        aggregateAsk > input.risk.balance) throw new Error('BULK_PROPOSAL_EXPOSURE_LIMIT');
    if (!canContinue(input)) throw new Error('BULK_STOPPED_BEFORE_PURCHASE');

    const age = Date.now() / 1000 - input.risk.lastTickEpoch;
    if (age > 15 || age < -5) throw new Error('BULK_ENTRY_SIGNAL_EXPIRED');

    const buyResults = await Promise.allSettled(proposals.map(proposal =>
        input.api.send({ buy: proposal.id, price: proposal.askPrice })
    ));
    const purchased: Array<{ contractId: number; buyPrice: number }> = [];
    const failures: string[] = [];
    buyResults.forEach((result, index) => {
        if (result.status === 'rejected') {
            failures.push('PURCHASE_OUTCOME_UNKNOWN');
            return;
        }
        const error = apiError(result.value);
        if (error) {
            failures.push('PURCHASE_REJECTED');
            return;
        }
        const contractId = Number(result.value?.buy?.contract_id);
        if (!Number.isSafeInteger(contractId) || contractId <= 0) {
            failures.push('PURCHASE_RESULT_UNCONFIRMED');
            return;
        }
        purchased.push({ contractId, buyPrice: proposals[index].askPrice });
        try {
            input.onPurchased?.({
                contractId, buyPrice: proposals[index].askPrice,
                symbol: input.symbol, contractType: input.contractType,
            });
        } catch { /* A UI observer cannot interrupt confirmed trade monitoring. */ }
    });

    const settlements = await Promise.all(purchased.map(async purchase => {
        const settled = await monitorDerivContract(input.api, purchase.contractId, input.settlementTimeoutMs ?? 120_000);
        const status = String(settled.status || '').toLowerCase();
        const profit = Number(settled.profit);
        if (!['won', 'lost', 'sold', 'void'].includes(status) || !Number.isFinite(profit)) {
            throw new Error('BULK_SETTLEMENT_NOT_VERIFIED');
        }
        const result: VerifiedTradeResult = {
            contractId: purchase.contractId, symbol: input.symbol, contractType: input.contractType,
            buyPrice: purchase.buyPrice,
            settlement: status === 'won' ? 'WON' : status === 'lost' ? 'LOST' : 'VOID',
            profit, settledAt: Date.now(),
        };
        try { input.onSettled?.(result); } catch { /* Keep monitoring results independent of UI observers. */ }
        return result;
    }));

    if (failures.length) throw new Error('BULK_PARTIAL_EXECUTION_REQUIRES_ACCOUNT_RECONCILIATION: ' + failures.join(','));
    if (settlements.length !== count) throw new Error('BULK_EXECUTION_COUNT_NOT_CONFIRMED');
    return settlements;
}
