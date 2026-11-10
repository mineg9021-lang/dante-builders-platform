import type { DerivContractType } from './contracts';

export type BotStrategyId =
    | 'RISE' | 'FALL' | 'ONLY_UP' | 'ONLY_DOWN'
    | 'ASIAN_UP' | 'ASIAN_DOWN'
    | 'DIGIT_MATCH' | 'DIGIT_DIFFERS' | 'DIGIT_OVER' | 'DIGIT_UNDER'
    | 'EVEN' | 'ODD';

export type StrategyTick = {
    symbol: string;
    quote: string;
    epoch: number;
    digit: number;
};

export type BotStrategyConfig = {
    id: BotStrategyId;
    minSample?: number;
    maxSample?: number;
    runLength?: number;
    barrier?: number;
    prediction?: number;
    duration?: number;
    durationUnit?: 't' | 's' | 'm';
};

export type StrategyDecisionResult = {
    decision: 'READY' | 'WAIT' | 'REJECTED';
    contractType: DerivContractType;
    proposalFields: {
        duration: number;
        duration_unit: 't' | 's' | 'm';
        barrier?: string;
    };
    sampleSize: number;
    evidenceScore: number;
    reason: string;
    opportunityKey?: string;
    strategyMetrics?: { evenCount: number; oddCount: number; fullRate: number; firstRate: number; secondRate: number };
};

const CONTRACT_BY_STRATEGY: Record<BotStrategyId, DerivContractType> = {
    RISE: 'CALL',
    FALL: 'PUT',
    ONLY_UP: 'RUNHIGH',
    ONLY_DOWN: 'RUNLOW',
    ASIAN_UP: 'ASIANU',
    ASIAN_DOWN: 'ASIAND',
    DIGIT_MATCH: 'DIGITMATCH',
    DIGIT_DIFFERS: 'DIGITDIFF',
    DIGIT_OVER: 'DIGITOVER',
    DIGIT_UNDER: 'DIGITUNDER',
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
};

const wait = (id: BotStrategyId, sampleSize: number, reason: string): StrategyDecisionResult => ({
    decision: 'WAIT',
    contractType: CONTRACT_BY_STRATEGY[id],
    proposalFields: { duration: 5, duration_unit: 't' },
    sampleSize,
    evidenceScore: 0,
    reason,
});

const validTicks = (ticks: StrategyTick[], symbol: string, maxSample: number, now: number) => {
    const selected = ticks.filter(t => t.symbol === symbol).slice(-maxSample);
    const result: StrategyTick[] = [];
    let previousEpoch = 0;
    for (const tick of selected) {
        if (!Number.isFinite(tick.epoch) || tick.epoch <= previousEpoch ||
            tick.epoch - now > 5 ||
            typeof tick.quote !== 'string' || !/^[-+]?\d+(?:\.\d+)?$/.test(tick.quote) ||
            !Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9) continue;
        result.push(tick);
        previousEpoch = tick.epoch;
    }
    // Historical ticks may span longer than the live-feed freshness window.
    // Validate freshness on the newest tick, not on every sample tick.
    if (result.length && now - result[result.length - 1].epoch > 15) return [];
    return result;
};

const numeric = (tick: StrategyTick) => Number(tick.quote);

export function evaluateBotStrategy(input: {
    symbol: string;
    ticks: StrategyTick[];
    config: BotStrategyConfig;
    nowSeconds?: number;
}): StrategyDecisionResult {
    const { id } = input.config;
    const now = input.nowSeconds ?? Date.now() / 1000;
    const maxSample = Math.max(5, Math.min(200, input.config.maxSample ?? 40));
    const sample = validTicks(input.ticks, input.symbol, maxSample, now);
    const minimum = Math.max(5, Math.min(maxSample, input.config.minSample ?? 12));
    const duration = Math.max(1, Math.min(100, Math.floor(input.config.duration ?? 5)));
    const durationUnit = input.config.durationUnit ?? 't';

    if (!input.symbol || !CONTRACT_BY_STRATEGY[id]) {
        return { ...wait(id, sample.length, 'Unsupported strategy or market.'), decision: 'REJECTED' };
    }
    if (sample.length < minimum) return wait(id, sample.length, 'Collecting a bounded, fresh tick sample.');

    const last = sample[sample.length - 1];
    const opportunityKey = [id, input.symbol, last.epoch].join(':');
    const proposalFields: StrategyDecisionResult['proposalFields'] = {
        duration,
        duration_unit: durationUnit,
    };

    if (id === 'ONLY_UP' || id === 'ONLY_DOWN') {
        const required = Math.max(3, Math.min(30, input.config.runLength ?? 5));
        const tail = sample.slice(-required);
        if (tail.length < required) return wait(id, sample.length, 'Waiting for the complete consecutive-tick window.');
        const prices = tail.map(numeric);
        const strictlyUp = prices.every((price, index) => index === 0 || price > prices[index - 1]);
        const strictlyDown = prices.every((price, index) => index === 0 || price < prices[index - 1]);
        const matched = id === 'ONLY_UP' ? strictlyUp : strictlyDown;
        if (!matched) return wait(id, sample.length, 'The required consecutive direction has not been confirmed.');
        return {
            decision: 'READY', contractType: CONTRACT_BY_STRATEGY[id], proposalFields,
            sampleSize: sample.length, evidenceScore: 100,
            reason: 'The complete configured run is strictly directional; equal or opposing ticks invalidate the entry.',
            opportunityKey,
        };
    }

    if (id === 'RISE' || id === 'FALL' || id === 'ASIAN_UP' || id === 'ASIAN_DOWN') {
        const prices = sample.slice(-minimum).map(numeric);
        const changes = prices.slice(1).map((price, index) => price - prices[index]);
        const ups = changes.filter(change => change > 0).length;
        const downs = changes.filter(change => change < 0).length;
        const netUp = prices[prices.length - 1] > prices[0];
        const netDown = prices[prices.length - 1] < prices[0];
        const upRate = ups / changes.length;
        const downRate = downs / changes.length;
        const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
        const current = prices[prices.length - 1];
        const rising = netUp && upRate >= 0.7;
        const falling = netDown && downRate >= 0.7;
        const isUp = id === 'RISE' || id === 'ASIAN_UP';
        const directionValid = isUp ? rising : falling;
        const asianValid = id === 'ASIAN_UP' ? current > average : id === 'ASIAN_DOWN' ? current < average : true;
        const score = Math.round((isUp ? upRate : downRate) * 100);
        if (!directionValid || !asianValid) return {
            ...wait(id, sample.length, 'Directional momentum and contract-specific average-price confirmation have not both passed.'),
            evidenceScore: score,
        };
        return {
            decision: 'READY', contractType: CONTRACT_BY_STRATEGY[id], proposalFields,
            sampleSize: sample.length, evidenceScore: score,
            reason: id.startsWith('ASIAN_')
                ? 'Directional momentum and current-price-versus-sample-average checks passed; settlement still follows Deriv Asian contract rules.'
                : 'Directional momentum and net movement checks passed.',
            opportunityKey,
        };
    }

    const digits = sample.map(tick => tick.digit);
    const counts = Array.from({ length: 10 }, (_, digit) => digits.filter(value => value === digit).length);
    const mostFrequent = counts.reduce((best, count, digit) => count > counts[best] ? digit : best, 0);
    const leastFrequent = counts.reduce((best, count, digit) => count < counts[best] ? digit : best, 0);
    const sortedCounts = [...counts].sort((a, b) => b - a);
    const concentration = sortedCounts[0] / digits.length;
    const split = Math.floor(digits.length / 2);
    const first = digits.slice(0, split);
    const second = digits.slice(split);
    const parityRate = (values: number[], even: boolean) =>
        values.filter(digit => (digit % 2 === 0) === even).length / values.length;

    if (id === 'DIGIT_MATCH' || id === 'DIGIT_DIFFERS') {
        const prediction = Number.isInteger(input.config.prediction)
            ? Number(input.config.prediction)
            : id === 'DIGIT_MATCH' ? mostFrequent : leastFrequent;
        if (prediction < 0 || prediction > 9) return { ...wait(id, sample.length, 'Digit prediction must be from 0 to 9.'), decision: 'REJECTED' };
        proposalFields.barrier = String(prediction);
        const support = counts[prediction] / digits.length;
        if (support < 0.08 || support > 0.35) return {
            ...wait(id, sample.length, 'The selected digit has insufficient or excessive sample concentration for the configured rule.'),
            evidenceScore: Math.round(support * 100),
        };
        return {
            decision: 'READY', contractType: CONTRACT_BY_STRATEGY[id], proposalFields,
            sampleSize: sample.length, evidenceScore: Math.round(support * 100),
            reason: 'A bounded digit-frequency candidate passed the configured sample concentration check; this is historical evidence, not a guarantee.',
            opportunityKey,
        };
    }

    if (id === 'DIGIT_OVER' || id === 'DIGIT_UNDER') {
        const barrier = Number.isInteger(input.config.barrier) ? Number(input.config.barrier) : 4;
        if (barrier < 0 || barrier > 8) return { ...wait(id, sample.length, 'Barrier must be an integer from 0 to 8.'), decision: 'REJECTED' };
        proposalFields.barrier = String(barrier);
        const qualifying = digits.filter(digit => id === 'DIGIT_OVER' ? digit > barrier : digit < barrier);
        const rate = qualifying.length / digits.length;
        if (rate < 0.65) return { ...wait(id, sample.length, 'Observed barrier frequency is below the configured entry threshold.'), evidenceScore: Math.round(rate * 100) };
        return {
            decision: 'READY', contractType: CONTRACT_BY_STRATEGY[id], proposalFields,
            sampleSize: sample.length, evidenceScore: Math.round(rate * 100),
            reason: 'Observed barrier frequency passed the entry threshold; contract availability and risk gates remain mandatory.',
            opportunityKey,
        };
    }

    const even = id === 'EVEN';
    const fullRate = parityRate(digits, even);
    const firstRate = parityRate(first, even);
    const secondRate = parityRate(second, even);
    const strategyMetrics = {
        evenCount: digits.filter(digit => digit % 2 === 0).length,
        oddCount: digits.filter(digit => digit % 2 !== 0).length,
        fullRate,
        firstRate,
        secondRate,
    };
    if (fullRate < 0.58 || firstRate < 0.52 || secondRate < 0.52) {
        return {
            ...wait(id, sample.length, 'Parity frequency and split-window stability thresholds have not passed.'),
            evidenceScore: Math.round(fullRate * 100),
            strategyMetrics,
        };
    }
    return {
        decision: 'READY', contractType: CONTRACT_BY_STRATEGY[id], proposalFields,
        sampleSize: sample.length, evidenceScore: Math.round(fullRate * 100),
        reason: 'Observed parity frequency and both sample-half checks passed; historical frequency does not predict the next tick with certainty.',
        opportunityKey,
        strategyMetrics,
    };
}

export const getImplementedStrategyIds = (): BotStrategyId[] => [
    'RISE', 'FALL', 'ONLY_UP', 'ONLY_DOWN', 'ASIAN_UP', 'ASIAN_DOWN',
    'DIGIT_MATCH', 'DIGIT_DIFFERS', 'DIGIT_OVER', 'DIGIT_UNDER', 'EVEN', 'ODD',
];
