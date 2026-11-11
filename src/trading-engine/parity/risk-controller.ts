export type ParityRiskSnapshot = {
    authorized: boolean; isVirtual: boolean; mode: 'analysis' | 'demo' | 'live';
    stake: number; balance: number; maxStakePercent: number; sessionProfit: number; sessionLoss: number;
    stopLoss: number; takeProfit: number; tradesThisSession: number; maxTradesPerSession: number;
    consecutiveLosses: number; maxConsecutiveLosses: number; activeContracts: number; maxActiveContracts: number;
    cooldownUntil: number; now?: number;
};
export type RiskDecision = { allowed: boolean; reasons: string[] };

/** Fail-closed pre-purchase checks. The UI cannot override these decisions. */
export const evaluateParityRisk = (s: ParityRiskSnapshot): RiskDecision => {
    const reasons: string[] = [];
    const now = s.now ?? Date.now();
    if (s.mode === 'analysis') reasons.push('ANALYSIS_ONLY_MODE');
    if (!s.authorized) reasons.push('DERIV_NOT_AUTHORIZED');
    if (s.mode === 'demo' && !s.isVirtual) reasons.push('DEMO_ACCOUNT_REQUIRED');
    if (s.mode === 'live' && s.isVirtual) reasons.push('REAL_ACCOUNT_REQUIRED');
    if (!Number.isFinite(s.stake) || s.stake <= 0) reasons.push('INVALID_STAKE');
    if (!Number.isFinite(s.balance) || s.balance <= 0 || s.stake > s.balance) reasons.push('INSUFFICIENT_BALANCE');
    if (s.stake > s.balance * Math.min(2, Math.max(0, s.maxStakePercent)) / 100) reasons.push('ACCOUNT_EXPOSURE_LIMIT');
    if (s.sessionLoss >= s.stopLoss) reasons.push('SESSION_STOP_LOSS_REACHED');
    if (s.sessionProfit >= s.takeProfit) reasons.push('SESSION_TAKE_PROFIT_REACHED');
    if (s.tradesThisSession >= s.maxTradesPerSession) reasons.push('SESSION_TRADE_LIMIT_REACHED');
    if (s.consecutiveLosses >= s.maxConsecutiveLosses) reasons.push('CONSECUTIVE_LOSS_LIMIT_REACHED');
    if (s.activeContracts >= s.maxActiveContracts || s.activeContracts > 0) reasons.push('ACTIVE_CONTRACT_LIMIT_REACHED');
    if (now < s.cooldownUntil) reasons.push('COOLDOWN_ACTIVE');
    return { allowed: reasons.length === 0, reasons };
};
