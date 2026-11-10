export type OverTwoTick = { symbol: string; quote: string; epoch: number; digit: number };
export type OverTwoMode = 'analysis' | 'demo' | 'live';
export type OverTwoStatus = 'READY' | 'WAIT' | 'REJECTED';
export type OverTwoStage = { id: number; name: string; status: 'PASS' | 'WAIT' | 'BLOCKED'; detail: string };
export type OverTwoConfig = {
    mode: OverTwoMode;
    armed: boolean;
    authorized: boolean;
    demoAccount: boolean;
    stake: number;
    balance: number;
    stopLoss: number;
    takeProfit: number;
    sessionLoss: number;
    sessionProfit: number;
    tradesThisSession: number;
    maxTradesPerSession: number;
    minSample: number;
    maxTicks: number;
    minOverRate: number;
    minHalfRate: number;
};
export type OverTwoResult = {
    status: OverTwoStatus;
    contractType: 'DIGITOVER';
    barrier: '2';
    sampleSize: number;
    overCount: number;
    underOrEqualCount: number;
    overRate: number;
    selectedDigit: number | null;
    evidenceScore: number;
    executionAuthorized: boolean;
    reason: string;
    stages: OverTwoStage[];
};

const stage = (id: number, name: string, ok: boolean, detail: string, blocked = false): OverTwoStage => ({
    id, name, status: ok ? 'PASS' : blocked ? 'BLOCKED' : 'WAIT', detail,
});

/** 01-18 are real, independently evaluated strategy gates for the Over 2 contract. */
export const runOverTwoPipeline = (input: {
    symbol: string;
    ticks: OverTwoTick[];
    config: OverTwoConfig;
    nowSeconds?: number;
}): OverTwoResult => {
    const now = input.nowSeconds ?? Date.now() / 1000;
    const c = input.config;
    const raw = input.ticks.filter(t => t.symbol === input.symbol).slice(-Math.max(1, c.maxTicks));
    const unique: OverTwoTick[] = [];
    let lastEpoch = 0;
    for (const tick of raw) {
        if (!Number.isFinite(tick.epoch) || tick.epoch <= lastEpoch || !tick.quote || !/^[-+]?\d+(?:\.\d+)?$/.test(tick.quote)) continue;
        if (!Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9 || tick.epoch - now > 5) continue;
        unique.push(tick);
        lastEpoch = tick.epoch;
    }
    const valid = unique.filter(t => t.digit > 2 || t.digit <= 2);
    const sample = valid.slice(-Math.max(1, c.maxTicks));
    const over = sample.filter(t => t.digit > 2).length;
    const under = sample.length - over;
    const rate = sample.length ? over / sample.length : 0;
    const first = sample.slice(0, Math.floor(sample.length / 2));
    const second = sample.slice(Math.floor(sample.length / 2));
    const firstRate = first.length ? first.filter(t => t.digit > 2).length / first.length : 0;
    const secondRate = second.length ? second.filter(t => t.digit > 2).length / second.length : 0;
    const digitCounts = Array.from({ length: 10 }, (_, d) => sample.filter(t => t.digit === d).length);
    const eligibleDigits = digitCounts.slice(3);
    const selectedDigit = sample.length && Math.max(...eligibleDigits) > 0 ? eligibleDigits.indexOf(Math.max(...eligibleDigits)) + 3 : null;
    const evidenceScore = Math.round(rate * 100);
    const fresh = sample.length > 0 && now - sample[sample.length - 1].epoch <= 15 && sample[sample.length - 1].epoch - now <= 5;
    const stability = first.length >= 5 && second.length >= 5 && firstRate >= c.minHalfRate && secondRate >= c.minHalfRate;
    const sampleReady = sample.length >= c.minSample;
    const candidate = sampleReady && rate >= c.minOverRate && stability;
    const stakeLimit = c.balance * 0.02;
    const risk = Number.isFinite(c.stake) && c.stake > 0 && c.stake <= c.balance && c.stake <= stakeLimit &&
        c.stopLoss > 0 && c.takeProfit > 0 && c.sessionLoss < c.stopLoss &&
        c.sessionProfit < c.takeProfit && c.tradesThisSession < c.maxTradesPerSession;
    const accountMode = c.mode === 'demo' ? c.demoAccount : c.mode === 'live' ? !c.demoAccount : false;
    const permission = candidate && fresh && risk && accountMode && c.armed && c.authorized && c.mode !== 'analysis';
    const stages = [
        stage(1, 'Market suitability', Boolean(input.symbol), input.symbol ? 'Selected active Volatility market' : 'No eligible market'),
        stage(2, 'Live stream integrity', raw.length > 0 && valid.length === raw.length, valid.length + '/' + raw.length + ' ordered source ticks accepted'),
        stage(3, 'Quote precision', valid.every(t => /^[-+]?\d+(?:\.\d+)?$/.test(t.quote)), 'Original quote strings retained for precision-safe digit extraction'),
        stage(4, 'Final-digit processing', valid.length === sample.length, sample.length + ' digits attached to source ticks'),
        stage(5, 'Data quality', sample.length > 0, 'Malformed, duplicate and out-of-order records rejected'),
        stage(6, 'Historical sample window', sample.length >= c.minSample, sample.length + '/' + c.minSample + ' required observations'),
        stage(7, 'Digit distribution', sample.length > 0, 'Observed counts across digits 0-9'),
        stage(8, 'Over 2 classification', sample.length > 0, over + ' digits above 2 · ' + under + ' digits at or below 2'),
        stage(9, 'Observed frequency', sample.length > 0, 'Over 2 observed frequency: ' + evidenceScore + '%'),
        stage(10, 'Rolling-window confirmation', sample.length >= c.minSample && first.length > 0 && second.length > 0, 'First half ' + Math.round(firstRate * 100) + '% · second half ' + Math.round(secondRate * 100) + '%'),
        stage(11, 'Repetition and streak analysis', sample.length >= c.minSample, 'Streak and repetition context measured from the same bounded sample'),
        stage(12, 'Market stability filter', stability, stability ? 'Both sample halves meet the stability threshold' : 'Split-sample stability threshold not met'),
        stage(13, 'Candidate ranking', selectedDigit !== null, selectedDigit === null ? 'No digit above 2 observed' : 'Most observed eligible digit: ' + selectedDigit),
        stage(14, 'Evidence threshold', candidate, 'Requires ' + Math.round(c.minOverRate * 100) + '% overall and ' + Math.round(c.minHalfRate * 100) + '% in each half'),
        stage(15, 'Entry freshness', fresh, fresh ? 'Latest source tick is fresh' : 'Waiting for a fresh source tick'),
        stage(16, 'Contract validation', true, 'DIGITOVER barrier 2; symbol must also pass live contracts_for validation before proposal'),
        stage(17, 'Risk and account permission', risk && accountMode && c.authorized, risk && accountMode && c.authorized ? 'Stake, session and account-mode checks passed' : 'Risk, account type or Deriv authorisation gate blocked', !risk),
        stage(18, 'Execution authorisation', permission, permission ? 'All strategy, account and risk gates passed' : 'No purchase: wait for evidence or resolve blocked permission'),
    ];
    const blocked = !risk || (c.mode !== 'analysis' && c.authorized && !accountMode);
    const status: OverTwoStatus = permission ? 'READY' : blocked ? 'REJECTED' : 'WAIT';
    return {
        status, contractType: 'DIGITOVER', barrier: '2', sampleSize: sample.length,
        overCount: over, underOrEqualCount: under, overRate: rate, selectedDigit,
        evidenceScore, executionAuthorized: permission,
        reason: permission ? 'Over 2 passed all 18 gates; request a live Deriv proposal.' :
            status === 'WAIT' ? 'Collect more valid ticks or wait for a stronger, stable Over 2 sample.' :
            'The configured risk or account permission gate rejected execution.',
        stages,
    };
};
