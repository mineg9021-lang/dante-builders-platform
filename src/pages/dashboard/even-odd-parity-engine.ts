export type ParitySide = 'EVEN' | 'ODD';
export type EngineMode = 'analysis' | 'demo' | 'live';
export type PipelineStatus = 'READY' | 'WAIT' | 'REJECTED';

export type EngineTick = {
    symbol: string;
    quote: string;
    epoch: number;
    digit: number;
    parity: ParitySide;
};

export type ParityEngineConfig = {
    mode: EngineMode;
    armed: boolean;
    authorized: boolean;
    demoAccount: boolean;
    maxTicks: number;
    minSample: number;
    minLead: number;
    minStableRatio: number;
    stake: number;
    availableBalance: number;
    maxStakePercent: number;
    sessionLoss: number;
    stopLoss: number;
    takeProfit: number;
};

export type PipelineStage = {
    id: number;
    name: string;
    status: 'PASS' | 'WAIT' | 'BLOCKED';
    detail: string;
};

export type ParityJournalEntry = {
    startedAt: number;
    completedAt: number;
    symbol: string;
    sampleSize: number;
    evenCount: number;
    oddCount: number;
    selectedParity: ParitySide | 'NONE';
    evidenceScore: number;
    status: PipelineStatus;
    reason: string;
    mode: EngineMode;
    executionAuthorized: boolean;
    settlement?: 'WON' | 'LOST' | 'VOID';
    profit?: number;
};

export type PipelineResult = {
    status: PipelineStatus;
    selectedParity: ParitySide | 'NONE';
    sampleSize: number;
    evenCount: number;
    oddCount: number;
    evidenceScore: number;
    stabilityScore: number;
    contractType: 'DIGITEVEN' | 'DIGITODD' | null;
    executionAuthorized: boolean;
    reason: string;
    stages: PipelineStage[];
    journal: ParityJournalEntry;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const isParity = (value: number): value is number => Number.isInteger(value) && value >= 0 && value <= 9;
const parityOf = (digit: number): ParitySide => (digit % 2 === 0 ? 'EVEN' : 'ODD');

const stage = (
    id: number,
    name: string,
    status: PipelineStage['status'],
    detail: string
): PipelineStage => ({ id, name, status, detail });

/** 01 — Market listener hand-off: reject malformed market records before analysis. */
export const acquireMarketData = (ticks: EngineTick[], symbol: string, maxTicks: number) =>
    ticks.filter(tick => tick.symbol === symbol).slice(-Math.max(1, maxTicks));

/** 02 — Validate source tick ordering, timestamps and symbol identity. */
export const validateMarketData = (ticks: EngineTick[], symbol: string, nowSeconds: number) => {
    const valid: EngineTick[] = [];
    let previousEpoch = 0;
    ticks.forEach(tick => {
        if (tick.symbol !== symbol || !Number.isFinite(tick.epoch) || tick.epoch <= previousEpoch) return;
        if (nowSeconds - tick.epoch > 15 || tick.epoch - nowSeconds > 5) return;
        if (typeof tick.quote !== 'string' || !tick.quote.trim()) return;
        valid.push(tick);
        previousEpoch = tick.epoch;
    });
    return valid;
};

/** 03 — Digit processor: keep the digit attached to its original quote and tick. */
export const processDigits = (ticks: EngineTick[]) =>
    ticks.filter(tick => isParity(tick.digit) && parityOf(tick.digit) === tick.parity);

/** 04 — Digit recognition: classify even and odd observations. */
export const recognizeParity = (ticks: EngineTick[]) => {
    const even = ticks.filter(tick => tick.parity === 'EVEN').length;
    return { even, odd: ticks.length - even, total: ticks.length };
};

/** 05 — Historical profile: compare the full bounded sample distribution. */
export const historicalProfile = (ticks: EngineTick[]) => {
    const counts = Array.from({ length: 10 }, (_, digit) => ticks.filter(tick => tick.digit === digit).length);
    return { counts, mostObserved: counts.indexOf(Math.max(0, ...counts)) };
};

/** 06 — Rolling window: evaluate the latest segment separately from the full sample. */
export const rollingWindow = (ticks: EngineTick[], windowSize: number) =>
    ticks.slice(-Math.max(2, windowSize));

/** 07 — Candidate selector: select only the side with a measured sample lead. */
export const selectParityCandidate = (counts: { even: number; odd: number; total: number }) =>
    counts.even === counts.odd ? 'NONE' : counts.even > counts.odd ? 'EVEN' : 'ODD';

/** 08 — Candidate ranking: return the stronger observed side and its normalized lead. */
export const rankParityCandidate = (counts: { even: number; odd: number; total: number }) => ({
    side: selectParityCandidate(counts),
    lead: counts.total ? Math.abs(counts.even - counts.odd) / counts.total : 0,
});

/** 09 — Evidence score: sample imbalance only; it is not a next-tick probability. */
export const scoreParityEvidence = (counts: { even: number; odd: number; total: number }) =>
    counts.total ? Math.round((Math.abs(counts.even - counts.odd) / counts.total) * 100) : 0;

/** 10 — Stability filter: compare parity direction in the first and second halves. */
export const filterMarketStability = (ticks: EngineTick[]) => {
    const midpoint = Math.floor(ticks.length / 2);
    const halves = [ticks.slice(0, midpoint), ticks.slice(midpoint)];
    const leads = halves.map(half => {
        const even = half.filter(tick => tick.parity === 'EVEN').length;
        const odd = half.length - even;
        return even === odd ? 'NONE' : even > odd ? 'EVEN' : 'ODD';
    });
    const agreement = leads[0] !== 'NONE' && leads[0] === leads[1];
    return { stable: agreement, score: agreement ? 100 : 0, leads };
};

/** 11 — Prediction validation: require a repeated sample lead, never a forecast claim. */
export const validateParityEvidence = (
    side: ParitySide | 'NONE',
    evidenceScore: number,
    stability: ReturnType<typeof filterMarketStability>,
    config: ParityEngineConfig
) => side !== 'NONE' && evidenceScore >= config.minLead * 100 && stability.stable;

/** 12 — Entry confirmation: require enough fresh, validated ticks and a valid evidence gate. */
export const confirmEntry = (
    ticks: EngineTick[],
    evidenceValid: boolean,
    config: ParityEngineConfig,
    nowSeconds: number
) => ticks.length >= config.minSample && evidenceValid && ticks.length > 0 &&
    nowSeconds - ticks[ticks.length - 1].epoch <= 15;

/** 13 — Contract validation: map the selected parity to a supported parity contract identifier. */
export const validateParityContract = (side: ParitySide | 'NONE') => {
    if (side === 'EVEN') return 'DIGITEVEN' as const;
    if (side === 'ODD') return 'DIGITODD' as const;
    return null;
};

/** 14 — Risk controller: reject invalid stake, excessive exposure and breached session loss. */
export const controlRisk = (config: ParityEngineConfig) => {
    const stakeLimit = config.availableBalance * clamp(config.maxStakePercent, 0, 100) / 100;
    return Number.isFinite(config.stake) && config.stake > 0 &&
        config.stake <= stakeLimit && config.stake <= config.availableBalance &&
        config.stopLoss > 0 && config.takeProfit > 0 &&
        config.sessionLoss < config.stopLoss;
};

/** 15 — Sniper gate: require a fresh confirmed candidate and stable evidence. */
export const detectSniperSignal = (confirmed: boolean, stabilityScore: number, minStableRatio: number) =>
    confirmed && stabilityScore >= minStableRatio * 100;

/** 16 — Execution permission: live orders remain blocked until every explicit safety gate passes. */
export const authorizeExecution = (
    config: ParityEngineConfig,
    sniperReady: boolean,
    riskAccepted: boolean
) => {
    if (config.mode === 'analysis' || !config.armed || !config.authorized || !sniperReady || !riskAccepted) return false;
    if (config.mode === 'live' && config.demoAccount) return false;
    if (config.mode === 'demo' && !config.demoAccount) return false;
    return true;
};

/** 17 — Execution monitor: validate a returned settlement before recording an outcome. */
export const validateSettlement = (settlement?: { status?: string; profit?: number | string }) => {
    if (!settlement || !['won', 'lost', 'sold', 'void'].includes(String(settlement.status || '').toLowerCase())) {
        return null;
    }
    const status = String(settlement.status).toLowerCase();
    return {
        status: status === 'won' ? 'WON' as const : status === 'lost' ? 'LOST' as const : 'VOID' as const,
        profit: Number.isFinite(Number(settlement.profit)) ? Number(settlement.profit) : 0,
    };
};

/** 18 — Journal: create an auditable record for every scan, including blocked and WAIT outcomes. */
export const buildParityJournal = (input: Omit<ParityJournalEntry, 'completedAt'>, completedAt = Date.now()): ParityJournalEntry => ({
    ...input,
    completedAt,
});

export const runParityPipeline = (
    input: {
        symbol: string;
        ticks: EngineTick[];
        config: ParityEngineConfig;
        nowSeconds?: number;
        startedAt?: number;
        settlement?: { status?: string; profit?: number | string };
    }
): PipelineResult => {
    const nowSeconds = input.nowSeconds ?? Date.now() / 1000;
    const startedAt = input.startedAt ?? Date.now();
    const { config, symbol } = input;
    const stages: PipelineStage[] = [];
    const acquired = acquireMarketData(input.ticks, symbol, config.maxTicks);
    stages.push(stage(1, 'Live market acquisition', acquired.length ? 'PASS' : 'WAIT', `${acquired.length} source ticks received`));

    const validated = validateMarketData(acquired, symbol, nowSeconds);
    stages.push(stage(2, 'Tick data validation', validated.length === acquired.length && acquired.length ? 'PASS' : 'WAIT', `${validated.length}/${acquired.length} fresh ordered ticks accepted`));

    const processed = processDigits(validated);
    stages.push(stage(3, 'Digit processor', processed.length === validated.length && processed.length ? 'PASS' : 'WAIT', `${processed.length} digits linked to source quotes`));

    const counts = recognizeParity(processed);
    stages.push(stage(4, 'Parity recognition', processed.length ? 'PASS' : 'WAIT', `${counts.even} even · ${counts.odd} odd`));

    const profile = historicalProfile(processed);
    stages.push(stage(5, 'Historical profile', processed.length ? 'PASS' : 'WAIT', `Digit distribution collected; most observed digit ${processed.length ? profile.mostObserved : '—'}`));

    const rolling = rollingWindow(processed, Math.max(config.minSample, 20));
    stages.push(stage(6, 'Rolling analysis window', rolling.length ? 'PASS' : 'WAIT', `${rolling.length} recent observations in rolling window`));

    const candidate = selectParityCandidate(counts);
    stages.push(stage(7, 'Parity candidate selection', candidate !== 'NONE' ? 'PASS' : 'WAIT', `Observed side: ${candidate}`));

    const ranked = rankParityCandidate(counts);
    stages.push(stage(8, 'Candidate ranking', ranked.side !== 'NONE' ? 'PASS' : 'WAIT', `Observed lead: ${Math.round(ranked.lead * 100)}%`));

    const evidenceScore = scoreParityEvidence(counts);
    stages.push(stage(9, 'Evidence scoring', counts.total ? 'PASS' : 'WAIT', `Sample imbalance score: ${evidenceScore}% (not forecast probability)`));

    const stability = filterMarketStability(rolling);
    stages.push(stage(10, 'Market stability filter', stability.stable ? 'PASS' : 'WAIT', stability.stable ? 'Both sample halves agree' : 'Parity lead is not stable across both halves'));

    const evidenceValid = validateParityEvidence(candidate, evidenceScore, stability, config);
    stages.push(stage(11, 'Evidence validation', evidenceValid ? 'PASS' : 'WAIT', evidenceValid ? 'Minimum lead and stability requirements met' : 'Evidence threshold not met'));

    const confirmed = confirmEntry(processed, evidenceValid, config, nowSeconds);
    stages.push(stage(12, 'Entry confirmation', confirmed ? 'PASS' : 'WAIT', confirmed ? 'Sample, freshness and evidence gates passed' : 'Waiting for a confirmed setup'));

    const contractType = validateParityContract(candidate);
    stages.push(stage(13, 'Contract validation', contractType ? 'PASS' : 'BLOCKED', contractType || 'No parity contract selected'));

    const riskAccepted = controlRisk(config);
    stages.push(stage(14, 'Risk and exposure control', riskAccepted ? 'PASS' : 'BLOCKED', riskAccepted ? 'Stake and session limits accepted' : 'Risk configuration rejected'));

    const sniperReady = detectSniperSignal(confirmed, stability.score, config.minStableRatio);
    stages.push(stage(15, 'Sniper confirmation gate', sniperReady ? 'PASS' : 'WAIT', sniperReady ? 'Confirmed stable candidate' : 'No confirmed sniper entry'));

    const executionAuthorized = authorizeExecution(config, sniperReady, riskAccepted);
    stages.push(stage(16, 'Execution permission', executionAuthorized ? 'PASS' : 'BLOCKED', executionAuthorized ? 'Explicit mode and safety gates passed' : 'No order permission; analysis mode or safety gate blocked'));

    const settled = validateSettlement(input.settlement);
    stages.push(stage(17, 'Settlement validation', settled ? 'PASS' : 'WAIT', settled ? `Settlement: ${settled.status}` : 'No verified settlement received'));

    const status: PipelineStatus = executionAuthorized ? 'READY' : confirmed ? 'WAIT' : processed.length < config.minSample ? 'WAIT' : 'REJECTED';
    const reason = status === 'READY' ? 'Setup passed all gates; execution permission is available.' :
        status === 'WAIT' ? 'More valid market evidence or an explicit execution mode is required.' :
        'The setup failed one or more validation or risk gates.';
    const journal = buildParityJournal({
        startedAt,
        symbol,
        sampleSize: counts.total,
        evenCount: counts.even,
        oddCount: counts.odd,
        selectedParity: candidate,
        evidenceScore,
        status,
        reason,
        mode: config.mode,
        executionAuthorized,
        settlement: settled?.status,
        profit: settled?.profit,
    });
    stages.push(stage(18, 'Trading journal and metrics', 'PASS', `Journal record created · ${status} · ${counts.total} ticks`));

    return {
        status,
        selectedParity: candidate,
        sampleSize: counts.total,
        evenCount: counts.even,
        oddCount: counts.odd,
        evidenceScore,
        stabilityScore: stability.score,
        contractType,
        executionAuthorized,
        reason,
        stages,
        journal,
    };
};
