import { executeDerivBulk } from './bulk-execution';
import {
    executeDerivContract,
    type DerivTradingApi,
    type ExecutionRiskContext,
    type VerifiedTradeResult,
} from './execution';
import { evaluateBotStrategy, type BotStrategyConfig, type StrategyDecisionResult, type StrategyTick } from './strategy-adapters';
import { discoverContractsForSymbol, isContractAvailable } from './contracts';
import { runRobot18LayerEngine, type RobotEngineReport } from './robot-18-layer-engine';

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
    onEngineReport?: (report: RobotEngineReport) => void;
    onPurchased?: (purchase: { contractId: number; buyPrice: number; symbol: string; contractType: string }) => void;
    onSettled?: (result: VerifiedTradeResult) => void;
    onError?: (error: Error) => void;
    /** Maximum fresh ticks collected in one analysis cycle. Defaults to 30. */
    analysisMaxTicks?: number;
    /** Maximum duration of one analysis cycle. Defaults to 10 seconds. */
    analysisMaxDurationMs?: number;
    /** Number of simultaneous purchases per qualifying signal; 1 keeps normal single-trade mode. */
    bulkRuns?: number;
};

const toDecimalString = (value: string | number, precision: number): string | null => {
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) return null;
    const source = String(value).trim();
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(source)) return null;
    const [whole, fraction = ''] = source.split('.');
    // Never truncate excess digits: that would silently change the market's last digit.
    if (fraction.length > precision) return null;
    return precision === 0 ? whole : whole + '.' + fraction.padEnd(precision, '0');
};

const extractDigit = (quote: string, precision: number): number | null => {
    const decimal = quote.split('.')[1] || '';
    const digit = precision > 0 ? decimal[precision - 1] : quote.replace(/\D/g, '').slice(-1);
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
    let analysisClosed = false;
    const analysisTicksBySymbol = new Map<string, number>(eligibleSymbols.map(symbol => [symbol, 0]));
    const activeSymbols = new Set<string>();
    let subscriptionsReady = false;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    const maxAnalysisTicks = Math.max(5, Math.min(500, Math.floor(input.analysisMaxTicks ?? 30)));
    const maxAnalysisDurationMs = Math.max(1000, Math.min(120000, Math.floor(input.analysisMaxDurationMs ?? 10000)));
    const subscriptionIds: string[] = [];
    let tickStream: { unsubscribe: () => void } | undefined;
    const ticksBySymbol = new Map<string, StrategyTick[]>(eligibleSymbols.map(symbol => [symbol, []]));
    const canContinue = () => !stopped && (!input.shouldContinue || input.shouldContinue());
    // UI observers are non-authoritative: they must never interrupt market handling or execution.
    const notify = (observer: (() => void) | undefined) => {
        try { observer?.(); } catch { /* Keep the trading state machine independent of UI callbacks. */ }
    };
    const setStatus = (next: RuntimeStatus, message: string) => {
        status = next;
        notify(() => input.onStatus?.(next, message));
    };
    const clearAnalysisTimer = () => {
        if (analysisTimer) clearTimeout(analysisTimer);
        analysisTimer = undefined;
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearAnalysisTimer();
        tickStream?.unsubscribe();
        subscriptionIds.splice(0).forEach(id => {
            void Promise.resolve(input.api.send({ forget: id })).catch(() => undefined);
        });
        setStatus('STOPPED', 'Bot stopped. No new purchases will be initiated.');
    };
    const expireAnalysis = (reason: string) => {
        if (stopped || executing || analysisClosed) return;
        analysisClosed = true;
        clearAnalysisTimer();
        const symbol = eligibleSymbols.find(candidate => (ticksBySymbol.get(candidate)?.length ?? 0) > 0) ?? eligibleSymbols[0];
        const finalDecision = evaluateBotStrategy({
            symbol,
            ticks: ticksBySymbol.get(symbol) ?? [],
            config: input.strategy,
        });
        notify(() => input.onDecision?.({ ...finalDecision, decision: 'REJECTED', reason, opportunityKey: undefined }));
        stop();
        setStatus('PAUSED_ERROR', reason + ' No purchase was made. Restart analysis to try again.');
    };
    const beginAnalysisWindow = () => {
        clearAnalysisTimer();
        analysisClosed = false;
        analysisTicksBySymbol.forEach((_, symbol) => analysisTicksBySymbol.set(symbol, 0));
        ticksBySymbol.forEach(symbolTicks => { symbolTicks.length = 0; });
        analysisTimer = setTimeout(() => {
            expireAnalysis('ANALYSIS_TIME_LIMIT_REACHED');
        }, maxAnalysisDurationMs);
    };
    const handleTick = (raw: any) => {
        if (!canContinue() || raw?.msg_type !== 'tick' || typeof raw?.tick?.symbol !== 'string') return;
        const symbol = raw.tick.symbol as string;
        const symbolTicks = ticksBySymbol.get(symbol);
        if (!symbolTicks) return;
        const epoch = Number(raw.tick.epoch);
        // Deriv supplies pip_size on every tick. It is the authoritative precision
        // for this quote; configured values are only consistency constraints.
        const precision = raw.tick.pip_size;
        const configuredPrecision = input.precisionBySymbol?.[symbol] ?? input.precision;
        if (!Number.isInteger(precision) || precision < 0 || precision > 10) return;
        if (configuredPrecision !== undefined && configuredPrecision !== precision) return;
        const quote = toDecimalString(raw.tick.quote, precision);
        if (!Number.isFinite(epoch) || !quote) return;
        const previous = symbolTicks[symbolTicks.length - 1];
        if (previous && epoch <= previous.epoch) return;
        const digit = extractDigit(quote, precision);
        if (digit === null) return;
        symbolTicks.push({ symbol, quote, epoch, digit });
        if (symbolTicks.length > 200) symbolTicks.splice(0, symbolTicks.length - 200);
        if (executing || analysisClosed) return;
        const marketAnalysisTicks = analysisTicksBySymbol.get(symbol) ?? 0;
        if (marketAnalysisTicks >= maxAnalysisTicks) return;
        analysisTicksBySymbol.set(symbol, marketAnalysisTicks + 1);

        const decision = evaluateBotStrategy({ symbol, ticks: symbolTicks, config: input.strategy });
        notify(() => input.onDecision?.(decision));
        if (decision.decision !== 'READY' || !decision.opportunityKey) {
            const allMarketsExhausted = subscriptionsReady && activeSymbols.size > 0 &&
                Array.from(activeSymbols).every(activeSymbol => (analysisTicksBySymbol.get(activeSymbol) ?? 0) >= maxAnalysisTicks);
            if (allMarketsExhausted) expireAnalysis('ANALYSIS_TICK_LIMIT_REACHED');
            return;
        }
        const baseRisk = input.getRiskContext ? input.getRiskContext() : input.risk;
        const risk: ExecutionRiskContext = { ...baseRisk, strategyDecision: decision.decision, lastTickEpoch: epoch };
        const engineReport = runRobot18LayerEngine({
            symbol,
            tick: symbolTicks[symbolTicks.length - 1],
            previous: symbolTicks.length > 1 ? symbolTicks[symbolTicks.length - 2] : undefined,
            sample: symbolTicks.slice(-Math.max(5, Math.min(200, input.strategy.maxSample ?? 40))),
            config: input.strategy,
            decision,
            contractAvailable: eligibleSymbols.includes(symbol),
            risk,
        });
        notify(() => input.onEngineReport?.(engineReport));
        if (!engineReport.passed) {
            notify(() => input.onDecision?.({
                ...decision,
                decision: 'REJECTED',
                reason: '18-LAYER ENGINE BLOCKED AT ' + engineReport.blockedAt + ': ' + engineReport.reason,
                opportunityKey: undefined,
            }));
            stop();
            setStatus('PAUSED_ERROR', 'Shared 18-layer robot engine rejected this entry. ' + engineReport.reason);
            return;
        }
        analysisClosed = true;
        clearAnalysisTimer();

        executing = true;
        setStatus('EXECUTING', 'READY · validating contract, risk and Deriv proposal.');
        const bulkRuns = Math.max(1, Math.min(20, Math.floor(input.bulkRuns ?? 1)));
        const execution = bulkRuns > 1
            ? executeDerivBulk({
                api: input.api,
                symbol,
                contractType: decision.contractType,
                currency: input.currency,
                proposalFields: decision.proposalFields,
                risk,
                runs: bulkRuns,
                idempotencyKey: symbol + ':' + decision.opportunityKey + ':bulk:' + bulkRuns,
                shouldContinue: canContinue,
                onPurchased: purchase => notify(() => input.onPurchased?.(purchase)),
                onSettled: result => notify(() => input.onSettled?.(result)),
            })
            : executeDerivContract({
                api: input.api,
                symbol,
                contractType: decision.contractType,
                currency: input.currency,
                proposalFields: decision.proposalFields,
                risk,
                idempotencyKey: symbol + ':' + decision.opportunityKey,
                shouldContinue: canContinue,
                onPurchased: purchase => notify(() => input.onPurchased?.(purchase)),
            }).then(result => {
                notify(() => input.onSettled?.(result));
                return [result];
            });
        void execution.then(results => {
            executing = false;
            if (!stopped) {
                setStatus('RUNNING', results.length > 1
                    ? results.length + ' bulk purchases settled and verified. Starting a fresh bounded analysis cycle.'
                    : 'Settlement verified. Starting a fresh bounded analysis cycle.');
                beginAnalysisWindow();
            }
        }).catch(error => {
            executing = false;
            const reason = error instanceof Error ? error : new Error('DERIV_EXECUTION_FAILED');
            notify(() => input.onError?.(reason));
            if (/PURCHASE_RESULT_UNCONFIRMED|PURCHASE_OUTCOME_UNKNOWN|SETTLEMENT_NOT_VERIFIED|SETTLEMENT_MONITOR_TIMEOUT|SETTLEMENT_MONITOR_FAILED|BULK_PARTIAL_EXECUTION|BULK_SETTLEMENT_NOT_VERIFIED|BULK_EXECUTION_COUNT_NOT_CONFIRMED/.test(reason.message)) {
                stop();
                setStatus('PAUSED_ERROR', reason.message + ' Reconcile the Deriv account before restarting.');
            } else if (!stopped) {
                setStatus('RUNNING', reason.message);
                beginAnalysisWindow();
            }
        });
    };

    beginAnalysisWindow();
    tickStream = input.api.onMessage().subscribe(handleTick);
    const subscriptionResults = await Promise.all(eligibleSymbols.map(async symbol => {
        if (!canContinue()) return null;
        try {
            const response = await input.api.send({ ticks: symbol, subscribe: 1 });
            if (response?.error) return null;
            const id = response?.subscription?.id;
            if (!canContinue()) {
                if (typeof id === 'string') void Promise.resolve(input.api.send({ forget: id })).catch(() => undefined);
                return null;
            }
            if (typeof id === 'string') subscriptionIds.push(id);
            activeSymbols.add(symbol);
            handleTick(response);
            return symbol;
        } catch {
            return null;
        }
    }));
    if (!canContinue()) {
        tickStream.unsubscribe();
        subscriptionIds.splice(0).forEach(id => void Promise.resolve(input.api.send({ forget: id })).catch(() => undefined));
        if (!stopped) {
            stopped = true;
            status = 'STOPPED';
        }
        return { stop, getStatus: () => status, getTicks: () => Array.from(ticksBySymbol.values()).flat() };
    }
    subscriptionsReady = true;
    if (!subscriptionResults.some(Boolean)) {
        clearAnalysisTimer();
        tickStream.unsubscribe();
        throw new Error('NO_MARKET_TICK_SUBSCRIPTIONS_AVAILABLE');
    }
    if (!stopped && Array.from(activeSymbols).every(activeSymbol => (analysisTicksBySymbol.get(activeSymbol) ?? 0) >= maxAnalysisTicks)) {
        expireAnalysis('ANALYSIS_TICK_LIMIT_REACHED');
    }
    if (stopped) {
        subscriptionIds.splice(0).forEach(id => void Promise.resolve(input.api.send({ forget: id })).catch(() => undefined));
    } else if (!executing) {
        setStatus('RUNNING', 'Connected to live Deriv ticks across eligible Volatility markets. Waiting for a validated opportunity.');
    }
    return {
        stop,
        getStatus: () => status,
        getTicks: () => Array.from(ticksBySymbol.values()).flat(),
    };
}
