import { discoverContractsForSymbol, isContractAvailable, type DerivContractType } from './contracts';

export type TradingMode = 'demo' | 'live';
export type StrategyDecision = 'READY' | 'WAIT' | 'REJECTED';
export type DerivTradingApi = {
    send: (request: Record<string, unknown>) => Promise<any>;
    onMessage: () => {
        subscribe: (callback: (message: any) => void) => { unsubscribe: () => void };
    };
};

export type ContractProposalFields = {
    duration?: number;
    duration_unit?: 't' | 's' | 'm' | 'h' | 'd';
    date_expiry?: number;
    date_start?: number;
    barrier?: string | number;
    barrier2?: string | number;
    prediction?: number;
    multiplier?: number;
    cancellation?: string;
    growth_rate?: number;
};

export type ExecutionRiskContext = {
    mode: TradingMode;
    authorized: boolean;
    isVirtual: boolean;
    liveTradingConfirmed: boolean;
    strategyDecision: StrategyDecision;
    lastTickEpoch: number;
    nowSeconds?: number;
    stake: number;
    balance: number;
    maxStake: number;
    maxStakePercent: number;
    sessionPnl: number;
    stopLoss: number;
    takeProfit: number;
    tradesThisSession: number;
    maxTradesPerSession: number;
};

export type ExecuteDerivContractInput = {
    api: DerivTradingApi;
    symbol: string;
    contractType: DerivContractType;
    currency: string;
    proposalFields: ContractProposalFields;
    risk: ExecutionRiskContext;
    /** Stable key for this signal/session. A key is never auto-reused after execution starts. */
    idempotencyKey: string;
    shouldContinue?: () => boolean;
    onPurchased?: (purchase: { contractId: number; buyPrice: number; symbol: string; contractType: DerivContractType }) => void;
    settlementTimeoutMs?: number;
};

export type VerifiedTradeResult = {
    contractId: number;
    symbol: string;
    contractType: DerivContractType;
    buyPrice: number;
    settlement: 'WON' | 'LOST' | 'VOID';
    profit: number;
    settledAt: number;
};

const consumedExecutionKeys = new Set<string>();
const ALLOWED_PROPOSAL_FIELDS = new Set([
    'duration', 'duration_unit', 'date_expiry', 'date_start', 'barrier',
    'barrier2', 'prediction', 'multiplier', 'cancellation', 'growth_rate',
]);

export function validateExecutionRisk(
    risk: ExecutionRiskContext,
    nowSeconds = Date.now() / 1000
): string | null {
    if (!risk.authorized) return 'DERIV_ACCOUNT_NOT_AUTHORIZED';
    if (risk.mode === 'demo' && !risk.isVirtual) return 'DEMO_MODE_REQUIRES_VIRTUAL_ACCOUNT';
    if (risk.mode === 'live' && (risk.isVirtual || !risk.liveTradingConfirmed)) return 'LIVE_TRADING_NOT_CONFIRMED';
    if (risk.strategyDecision !== 'READY') return 'STRATEGY_NOT_READY';
    if (!Number.isFinite(risk.lastTickEpoch) || nowSeconds - risk.lastTickEpoch > 15 || risk.lastTickEpoch - nowSeconds > 5) return 'ENTRY_TICK_STALE';
    if (!Number.isFinite(risk.stake) || risk.stake <= 0) return 'INVALID_STAKE';
    if (!Number.isFinite(risk.balance) || risk.balance <= 0 || risk.stake > risk.balance) return 'INSUFFICIENT_BALANCE';
    if (!Number.isFinite(risk.maxStake) || risk.maxStake <= 0 || risk.stake > risk.maxStake) return 'MAX_STAKE_EXCEEDED';
    if (!Number.isFinite(risk.maxStakePercent) || risk.maxStakePercent <= 0 || risk.stake > risk.balance * risk.maxStakePercent / 100) return 'STAKE_EXPOSURE_LIMIT';
    if (!Number.isFinite(risk.stopLoss) || risk.stopLoss <= 0 || risk.sessionPnl <= -risk.stopLoss) return 'SESSION_STOP_LOSS_REACHED';
    if (!Number.isFinite(risk.takeProfit) || risk.takeProfit <= 0 || risk.sessionPnl >= risk.takeProfit) return 'SESSION_TAKE_PROFIT_REACHED';
    if (!Number.isInteger(risk.tradesThisSession) || risk.tradesThisSession < 0 ||
        !Number.isInteger(risk.maxTradesPerSession) || risk.maxTradesPerSession < 1 ||
        risk.tradesThisSession >= risk.maxTradesPerSession) return 'SESSION_TRADE_LIMIT_REACHED';
    return null;
}

export function buildProposalRequest(input: Pick<ExecuteDerivContractInput,
    'symbol' | 'contractType' | 'currency' | 'proposalFields' | 'risk'>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.proposalFields || {})) {
        if (ALLOWED_PROPOSAL_FIELDS.has(key) && value !== undefined && value !== null && value !== '') {
            fields[key] = value;
        }
    }
    const hasDuration = Number.isInteger(fields.duration) && Number(fields.duration) > 0 &&
        typeof fields.duration_unit === 'string';
    const hasExpiry = Number.isInteger(fields.date_expiry) && Number(fields.date_expiry) > 0;
    if (!hasDuration && !hasExpiry) throw new Error('DURATION_OR_EXPIRY_REQUIRED');
    if (!input.symbol || !input.currency) throw new Error('SYMBOL_AND_CURRENCY_REQUIRED');
    return {
        proposal: 1,
        amount: input.risk.stake,
        basis: 'stake',
        contract_type: input.contractType,
        currency: input.currency,
        underlying_symbol: input.symbol,
        ...fields,
    };
}

const apiError = (response: any) =>
    response?.error?.message || response?.error?.code || null;

const isTerminal = (contract: any) =>
    ['won', 'lost', 'sold', 'void'].includes(String(contract?.status || '').toLowerCase()) ||
    contract?.is_sold === 1 || contract?.is_expired === 1;

/**
 * One-shot Deriv execution pipeline shared by specialist strategies.
 * It deliberately performs no automatic purchase retries or martingale progression.
 */
export async function executeDerivContract(input: ExecuteDerivContractInput): Promise<VerifiedTradeResult> {
    const riskError = validateExecutionRisk(input.risk);
    if (riskError) throw new Error(riskError);
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error('INVALID_IDEMPOTENCY_KEY');
    if (consumedExecutionKeys.has(input.idempotencyKey)) throw new Error('DUPLICATE_OPPORTUNITY_BLOCKED');
    const canContinue = () => !input.shouldContinue || input.shouldContinue();
    if (!canContinue()) throw new Error('BOT_STOPPED_BEFORE_EXECUTION');

    // Reserve the opportunity before the first network request. Never blindly retry
    // after an uncertain response: the caller must reconcile account/contract state.
    consumedExecutionKeys.add(input.idempotencyKey);

    const available = await discoverContractsForSymbol(input.api, input.symbol);
    if (!isContractAvailable(available, input.contractType)) throw new Error('CONTRACT_NOT_AVAILABLE_FOR_SYMBOL');
    if (!canContinue()) throw new Error('BOT_STOPPED_BEFORE_PROPOSAL');

    const proposalRequest = buildProposalRequest(input);
    const proposalResponse = await input.api.send(proposalRequest);
    const proposalError = apiError(proposalResponse);
    if (proposalError) throw new Error('PROPOSAL_REJECTED: ' + proposalError);
    const proposal = proposalResponse?.proposal;
    const proposalId = String(proposal?.id || '');
    const askPrice = Number(proposal?.ask_price);
    if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0 || askPrice > input.risk.maxStake) {
        throw new Error('INVALID_OR_OVER_LIMIT_PROPOSAL');
    }
    if (!canContinue()) throw new Error('BOT_STOPPED_BEFORE_PURCHASE');
    const age = Date.now() / 1000 - input.risk.lastTickEpoch;
    if (age > 15 || age < -5) throw new Error('ENTRY_CONFIRMATION_EXPIRED');

    // No retry on this call. A transport failure may have an uncertain purchase outcome.
    const buyResponse = await input.api.send({ buy: proposalId, price: askPrice });
    const buyError = apiError(buyResponse);
    if (buyError) throw new Error('PURCHASE_REJECTED: ' + buyError);
    const contractId = Number(buyResponse?.buy?.contract_id);
    if (!Number.isSafeInteger(contractId) || contractId <= 0) throw new Error('PURCHASE_RESULT_UNCONFIRMED');
    input.onPurchased?.({ contractId, buyPrice: askPrice, symbol: input.symbol, contractType: input.contractType });

    const settled = await monitorDerivContract(input.api, contractId, input.settlementTimeoutMs ?? 120_000);
    const status = String(settled.status || '').toLowerCase();
    const profit = Number(settled.profit);
    if (!['won', 'lost', 'sold', 'void'].includes(status) || !Number.isFinite(profit)) {
        throw new Error('SETTLEMENT_NOT_VERIFIED');
    }
    return {
        contractId,
        symbol: input.symbol,
        contractType: input.contractType,
        buyPrice: askPrice,
        settlement: status === 'won' ? 'WON' : status === 'lost' ? 'LOST' : 'VOID',
        profit,
        settledAt: Date.now(),
    };
}

export function monitorDerivContract(
    api: DerivTradingApi,
    contractId: number,
    timeoutMs = 120_000
): Promise<{ status?: string; profit?: number | string }> {
    return new Promise((resolve, reject) => {
        let finished = false;
        let subscriptionId: string | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let stream: { unsubscribe: () => void } | undefined;
        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            stream?.unsubscribe();
            if (subscriptionId) void api.send({ forget: subscriptionId }).catch(() => undefined);
        };
        const finish = (contract: any) => {
            if (finished) return;
            finished = true;
            cleanup();
            resolve(contract);
        };
        timeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(new Error('SETTLEMENT_MONITOR_TIMEOUT_RECONCILE_REQUIRED'));
        }, timeoutMs);
        stream = api.onMessage().subscribe(message => {
            const contract = message?.proposal_open_contract;
            if (Number(contract?.contract_id) === contractId && isTerminal(contract)) finish(contract);
        });
        api.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }).then(response => {
            if (finished) {
                const lateId = response?.subscription?.id;
                if (lateId) void api.send({ forget: lateId }).catch(() => undefined);
                return;
            }
            const error = apiError(response);
            if (error) {
                finished = true;
                cleanup();
                reject(new Error('SETTLEMENT_MONITOR_FAILED: ' + error));
                return;
            }
            subscriptionId = response?.subscription?.id;
            if (response?.proposal_open_contract && isTerminal(response.proposal_open_contract)) {
                finish(response.proposal_open_contract);
            }
        }).catch(error => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(error instanceof Error ? error : new Error('SETTLEMENT_MONITOR_FAILED'));
        });
    });
}
