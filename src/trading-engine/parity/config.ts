export type ParityEngineMode = 'analysis' | 'demo' | 'live';
export type ParityEngineConfig = {
    mode: ParityEngineMode; symbol: string; stake: number; currency: string; minSample: number;
    maxAnalysisTicks: number; maxAnalysisMs: number; rollingWindow: number; minObservedLeadPercent: number;
    minStableRatio: number; maxStakePercent: number; stopLoss: number; takeProfit: number;
    maxConsecutiveLosses: number; maxTradesPerSession: number; cooldownMs: number; durationTicks: 1;
};
export const DEFAULT_PARITY_CONFIG: ParityEngineConfig = {
    mode: 'analysis', symbol: 'R_10', stake: 1, currency: 'USD', minSample: 30,
    maxAnalysisTicks: 30, maxAnalysisMs: 10_000, rollingWindow: 30, minObservedLeadPercent: 10,
    minStableRatio: 0.75, maxStakePercent: 2, stopLoss: 5, takeProfit: 5,
    maxConsecutiveLosses: 3, maxTradesPerSession: 10, cooldownMs: 5_000, durationTicks: 1,
};
export type ConfigValidation = { valid: boolean; errors: string[] };
export const validateParityConfig = (config: ParityEngineConfig): ConfigValidation => {
    const errors: string[] = [];
    if (!/^R_(10|25|50|75|100)(_1S)?$/.test(config.symbol)) errors.push('UNSUPPORTED_SYMBOL');
    if (!Number.isFinite(config.stake) || config.stake <= 0) errors.push('INVALID_STAKE');
    if (!config.currency || !/^[A-Z]{3}$/.test(config.currency)) errors.push('INVALID_CURRENCY');
    if (!Number.isInteger(config.minSample) || config.minSample < 10 || config.minSample > 500) errors.push('INVALID_MIN_SAMPLE');
    if (!Number.isInteger(config.maxAnalysisTicks) || config.maxAnalysisTicks < config.minSample || config.maxAnalysisTicks > 500) errors.push('INVALID_ANALYSIS_TICK_LIMIT');
    if (!Number.isInteger(config.maxAnalysisMs) || config.maxAnalysisMs < 1000 || config.maxAnalysisMs > 120000) errors.push('INVALID_ANALYSIS_TIME_LIMIT');
    if (!Number.isInteger(config.rollingWindow) || config.rollingWindow < 10 || config.rollingWindow > 500) errors.push('INVALID_ROLLING_WINDOW');
    if (config.minObservedLeadPercent < 0 || config.minObservedLeadPercent > 100) errors.push('INVALID_EVIDENCE_THRESHOLD');
    if (config.minStableRatio < 0 || config.minStableRatio > 1) errors.push('INVALID_STABILITY_THRESHOLD');
    if (config.maxStakePercent <= 0 || config.maxStakePercent > 2) errors.push('STAKE_EXPOSURE_LIMIT_EXCEEDED');
    if (config.stopLoss <= 0 || config.takeProfit <= 0) errors.push('INVALID_SESSION_LIMIT');
    if (!Number.isInteger(config.maxConsecutiveLosses) || config.maxConsecutiveLosses < 1) errors.push('INVALID_LOSS_LIMIT');
    if (!Number.isInteger(config.maxTradesPerSession) || config.maxTradesPerSession < 1) errors.push('INVALID_TRADE_LIMIT');
    if (config.cooldownMs < 0 || config.cooldownMs > 3600000) errors.push('INVALID_COOLDOWN');
    if (config.durationTicks !== 1) errors.push('PARITY_DURATION_MUST_BE_ONE_TICK');
    return { valid: errors.length === 0, errors };
};
