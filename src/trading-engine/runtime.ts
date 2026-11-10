import {
    executeDerivContract,
    type DerivTradingApi,
    type ExecutionRiskContext,
    type VerifiedTradeResult,
} from './execution';
import { evaluateBotStrategy, type BotStrategyConfig, type StrategyDecisionResult, type StrategyTick } from './strategy-adapters';
import { discoverContractsForSymbol, isContractAvailable } from './contracts';

export type RuntimeStatus = 'STARTING' | 'RUNNING' | 'EXECUTING' | 'STOPPED' | 'PAUSED_ERROR';
export type RuntimeHandle = {
    stop: () => void;
    getStatus: () => RuntimeStatus;
    getTicks: () => StrategyTick[];
};

export type StartStrategyRuntimeInput = {
    api: DerivTradingApi;
    symbol: string;
    precision: number;
    strategy: BotStrategyConfig;
    currency: string;
    risk: Omit<ExecutionRiskContext, 'strategyDecision' | 'lastTickEpoch'> & { liveTradingConfirmed: boolean };
    getRiskContext?: () => Omit<ExecutionRiskContext, 'strategyDecision' | 'lastTickEpoch'>;
    onStatus?: (status: RuntimeStatus, message: string) => void;
    onDecision?: (decision: StrategyDecisionResult) => void;
    onPurchased?: (purchase: { contractId: number; buyPrice: number; symbol: string; contractType: string }) => void;
    onSettled?: (result: VerifiedTradeResult) => void;
    onError?: (error: Error) => void;
};

const toDecimalString = (value: string | number, precision: number): string | null => {
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) return null;
    let source = String(value).trim();
    if (!/^[+-]?\\d+(?:\\.\\d+)?$/.test(source)) return null;
    const [whole, fraction = ''] = source.split('.');
    return precision === 0 ? whole : whole + '.' + fraction.padEnd(precision, '0').slice(0, precision);
};

const extractDigit = (quote: string, precision: number): number | null => {
    const decimal = quote.split('.')[1] || '';
    const digit = precision > 0 ? decimal[precision - 1] : quote.replace(/\\D/g, '').slice(-1);
    const parsed = Number(digit);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? parsed : null;
};

/**
 * Runs one specialist strategy against a real Deriv tick stream. A READY
 * decision enters the shared proposal -> buy -> settlement executor; WAIT
 * and REJECTED can never reach purchase.
 */
export async function startStrategyRuntime(input: StartStrategyRuntimeInput): Promise<RuntimeHandle> {
    if (!input.symbol || !input.currency) throw new Error('SYMBOL_AND_CURRENCY_REQUIRED');
    const contracts = await discoverContractsForSymbol(input.api, input.symbol);
    const { contractType } = evaluateBotStrategy({
        symbol: input.symbol,
        ticks: [],
        config: input.strategy,
        nowSeconds: Date.now() / 1000,
    });
    if (!isContractAvailable(contracts, contractType)) {
        throw new Error('CONTRACT_NOT_AVAILABLE_FOR_SELECTED_MARKET');
    }

    let status: RuntimeStatus = 'STARTING';
    let stopped = false;
    let executing = false;
    let subscriptionId: string | undefined;
    let tickStream: { unsubscribe: () => void } | undefined;
    const ticks: StrategyTick[] = [];
    const setStatus = (next: RuntimeStatus, message: string) => {
        status = next;
        input.onStatus?.(next, message);
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (tickStream) tickStream.unsubscribe();
        if (subscriptionId) void input.api.send({ forget: subscriptionId }).catch(() => undefined);
        setStatus('STOPPED', 'Bot stopped. No new purchases will be initiated.');
    };
    const handleTick = (raw: any) => {
        if (stopped || raw?.msg_type !== 'tick' || raw?.tick?.symbol !== input.symbol) return;
        const epoch = Number(raw.tick.epoch);
        const quote = toDecimalString(raw.tick.quote, input.precision);
        if (!Number.isFinite(epoch) || !quote) return;
        const previous = ticks[ticks.length - 1];
        if (previous && epoch <= previous.epoch) return;
        const digit = extractDigit(quote, input.precision);
        if (digit === null) return;
        ticks.push({ symbol: input.symbol, quote, epoch, digit });
        if (ticks.length > 200) ticks.splice(0, ticks.length - 200);
        if (executing) return;

        const decision = evaluateBotStrategy({
            symbol: input.symbol,
            ticks,
            config: input.strategy,
        });
        input.onDecision?.(decision);
        if (decision.decision !== 'READY' || !decision.opportunityKey) return;

        const baseRisk = input.getRiskContext ? input.getRiskContext() : input.risk;
        const risk: ExecutionRiskContext = {
            ...baseRisk,
            strategyDecision: decision.decision,
            lastTickEpoch: epoch,
        };
        executing = true;
        setStatus('EXECUTING', 'READY · validating contract, risk and Deriv proposal.');
        void executeDerivContract({
            api: input.api,
            symbol: input.symbol,
            contractType: decision.contractType,
            currency: input.currency,
            proposalFields: decision.proposalFields,
            risk,
            idempotencyKey: input.symbol + ':' + decision.opportunityKey,
            shouldContinue: () => !stopped,
            onPurchased: purchase => input.onPurchased?.(purchase),
        }).then(result => {
            input.onSettled?.(result);
            executing = false;
            if (!stopped) setStatus('RUNNING', 'Settlement verified. Waiting for the next independent opportunity.');
        }).catch(error => {
            executing = false;
            const reason = error instanceof Error ? error : new Error('DERIV_EXECUTION_FAILED');
            input.onError?.(reason);
            // A rejected proposal is safe to wait on. Unknown purchase or
            // settlement state is not: stop and require reconciliation.
            if (/PURCHASE_RESULT_UNCONFIRMED|SETTLEMENT_MONITOR_TIMEOUT|SETTLEMENT_MONITOR_FAILED/.test(reason.message)) {
                stop();
                setStatus('PAUSED_ERROR', reason.message + ' Reconcile the Deriv account before restarting.');
            } else if (!stopped) {
                setStatus('RUNNING', reason.message);
            }
        });
    };

    tickStream = input.api.onMessage().subscribe(handleTick);
    const response = await input.api.send({ ticks: input.symbol, subscribe: 1 });
    if (response?.error) {
        tickStream.unsubscribe();
        throw new Error(String(response.error.message || 'TICK_SUBSCRIPTION_FAILED'));
    }
    subscriptionId = response?.subscription?.id;
    handleTick(response);
    if (stopped && subscriptionId) void input.api.send({ forget: subscriptionId }).catch(() => undefined);
    if (!stopped) setStatus('RUNNING', 'Connected to live Deriv ticks. Waiting for a validated strategy opportunity.');
    return { stop, getStatus: () => status, getTicks: () => [...ticks] };
}
