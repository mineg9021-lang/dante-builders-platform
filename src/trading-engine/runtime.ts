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
    /** Use symbols for the hidden market universe; symbol remains for one-market compatibility. */
    symbol?: string;
    symbols?: string[];
    precision?: number;
    precisionBySymbol?: Record<string, number>;
    strategy: BotStrategyConfig;
    currency: string;
    risk: Omit<ExecutionRiskContext, 'strategyDecision' | 'lastTickEpoch'> & { liveTradingConfirmed: boolean };
    getRiskContext?: () => Omit<ExecutionRiskContext, 'strategyDecision' | 'lastTickEpoch'>;
    shouldContinue?: () => boolean;
    onStatus?: (status: RuntimeStatus, message: string) => void;
    onDecision?: (decision: StrategyDecisionResult) => void;
    onPurchased?: (purchase: { contractId: number; buyPrice: number; symbol: string; contractType: string }) => void;
    onSettled?: (result: VerifiedTradeResult) => void;
    onError?: (error: Error) => void;
};

const toDecimalString = (value: string | number, precision: number): string | null => {
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) return null;
    const source = String(value).trim();
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
 * Runs a specialist against one or more real Deriv tick streams. Only markets
 * that return the required contract from contracts_for are subscribed.
 * READY enters the shared executor; WAIT and REJECTED can never purchase.
 */
export async function startStrategyRuntime(input: StartStrategyRuntimeInput): Promise<RuntimeHandle> {
    if (!input.currency) throw new Error('CURRENCY_REQUIRED');
    const requestedSymbols = [...new Set((input.symbols?.length ? input.symbols : input.symbol ? [input.symbol] : [])
        .filter(symbol => /^[A-Za-z0-9_]{2,30}$/.test(symbol)))];
    if (!requestedSymbols.length) throw new Error('NO_VALID_MARKETS_CONFIGURED');

    const { contractType } = evaluateBotStrategy({
        symbol: requestedSymbols[0],
        ticks: [],
        config: input.strategy,
        nowSeconds: Date.now() / 1000,
    });
    const discovery = await Promise.all(requestedSymbols.map(async symbol => {
        try {
            const contracts = await discoverContractsForSymbol(input.api, symbol);
            return isContractAvailable(contracts, contractType) ? symbol : null;
        } catch {
            return null;
        }
    }));
    const eligibleSymbols = requestedSymbols.filter((_, index) => discovery[index] !== null);
    if (!eligibleSymbols.length) throw new Error('CONTRACT_NOT_AVAILABLE_FOR_CONFIGURED_MARKETS');

    let status: RuntimeStatus = 'STARTING';
    let stopped = false;
    let executing = false;
    const subscriptionIds: string[] = [];
    let tickStream: { unsubscribe: () => void } | undefined;
    const ticksBySymbol = new Map<string, StrategyTick[]>(eligibleSymbols.map(symbol => [symbol, []]));
    const canContinue = () => !stopped && (!input.shouldContinue || input.shouldContinue());
    const setStatus = (next: RuntimeStatus, message: string) => {
        status = next;
        input.onStatus?.(next, message);
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        tickStream?.unsubscribe();
        subscriptionIds.splice(0).forEach(id => {
            void input.api.send({ forget: id }).catch(() => undefined);
        });
        setStatus('STOPPED', 'Bot stopped. No new purchases will be initiated.');
    };
    const handleTick = (raw: any) => {
        if (!canContinue() || raw?.msg_type !== 'tick' || typeof raw?.tick?.symbol !== 'string') return;
        const symbol = raw.tick.symbol as string;
        const symbolTicks = ticksBySymbol.get(symbol);
        if (!symbolTicks) return;
        const epoch = Number(raw.tick.epoch);
        const precision = input.precisionBySymbol?.[symbol] ?? input.precision ?? 2;
        const quote = toDecimalString(raw.tick.quote, precision);
        if (!Number.isFinite(epoch) || !quote) return;
        const previous = symbolTicks[symbolTicks.length - 1];
        if (previous && epoch <= previous.epoch) return;
        const digit = extractDigit(quote, precision);
        if (digit === null) return;
        symbolTicks.push({ symbol, quote, epoch, digit });
        if (symbolTicks.length > 200) symbolTicks.splice(0, symbolTicks.length - 200);
        if (executing) return;

        const decision = evaluateBotStrategy({ symbol, ticks: symbolTicks, config: input.strategy });
        input.onDecision?.(decision);
        if (decision.decision !== 'READY' || !decision.opportunityKey) return;

        const baseRisk = input.getRiskContext ? input.getRiskContext() : input.risk;
        const risk: ExecutionRiskContext = { ...baseRisk, strategyDecision: decision.decision, lastTickEpoch: epoch };
        executing = true;
        setStatus('EXECUTING', 'READY · validating contract, risk and Deriv proposal.');
        void executeDerivContract({
            api: input.api,
            symbol,
            contractType: decision.contractType,
            currency: input.currency,
            proposalFields: decision.proposalFields,
            risk,
            idempotencyKey: symbol + ':' + decision.opportunityKey,
            shouldContinue: canContinue,
            onPurchased: purchase => input.onPurchased?.(purchase),
        }).then(result => {
            input.onSettled?.(result);
            executing = false;
            if (!stopped) setStatus('RUNNING', 'Settlement verified. Monitoring eligible markets for the next opportunity.');
        }).catch(error => {
            executing = false;
            const reason = error instanceof Error ? error : new Error('DERIV_EXECUTION_FAILED');
            input.onError?.(reason);
            if (/PURCHASE_RESULT_UNCONFIRMED|PURCHASE_OUTCOME_UNKNOWN|SETTLEMENT_MONITOR_TIMEOUT|SETTLEMENT_MONITOR_FAILED/.test(reason.message)) {
                stop();
                setStatus('PAUSED_ERROR', reason.message + ' Reconcile the Deriv account before restarting.');
            } else if (!stopped) {
                setStatus('RUNNING', reason.message);
            }
        });
    };

    tickStream = input.api.onMessage().subscribe(handleTick);
    const subscriptionResults = await Promise.all(eligibleSymbols.map(async symbol => {
        if (!canContinue()) return null;
        try {
            const response = await input.api.send({ ticks: symbol, subscribe: 1 });
            if (response?.error) return null;
            const id = response?.subscription?.id;
            if (!canContinue()) {
                if (typeof id === 'string') void input.api.send({ forget: id }).catch(() => undefined);
                return null;
            }
            if (typeof id === 'string') subscriptionIds.push(id);
            handleTick(response);
            return symbol;
        } catch {
            return null;
        }
    }));
    if (!canContinue()) {
        tickStream.unsubscribe();
        subscriptionIds.splice(0).forEach(id => void input.api.send({ forget: id }).catch(() => undefined));
        stopped = true;
        status = 'STOPPED';
        return { stop, getStatus: () => status, getTicks: () => Array.from(ticksBySymbol.values()).flat() };
    }
    if (!subscriptionResults.some(Boolean)) {
        tickStream.unsubscribe();
        throw new Error('NO_MARKET_TICK_SUBSCRIPTIONS_AVAILABLE');
    }
    if (stopped) {
        subscriptionIds.splice(0).forEach(id => void input.api.send({ forget: id }).catch(() => undefined));
    } else {
        setStatus('RUNNING', 'Connected to live Deriv ticks across eligible Volatility markets. Waiting for a validated opportunity.');
    }
    return {
        stop,
        getStatus: () => status,
        getTicks: () => Array.from(ticksBySymbol.values()).flat(),
    };
}
