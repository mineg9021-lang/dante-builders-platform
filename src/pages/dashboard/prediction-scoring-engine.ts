import type { DigitMetrics } from './market-metrics-engine';

export type BarrierEvidence = {
    barrier: number;
    qualifyingCount: number;
    nonQualifyingCount: number;
    observedRate: number;
    firstHalfRate: number;
    secondHalfRate: number;
    evidenceScore: number;
    stable: boolean;
    qualifies: boolean;
};

/**
 * Deterministic evidence scoring only. The score summarises a bounded historical sample;
 * it is not a calibrated probability or a claim about the next tick.
 */
export const scoreDigitBarrier = (
    digits: number[],
    metrics: DigitMetrics,
    barrier: number,
    minObservedRate: number,
    minHalfRate: number
): BarrierEvidence => {
    const eligible = (digit: number) => digit > barrier;
    const first = digits.slice(0, Math.floor(digits.length / 2));
    const second = digits.slice(Math.floor(digits.length / 2));
    const qualifyingCount = digits.filter(eligible).length;
    const firstHalfRate = first.length ? first.filter(eligible).length / first.length : 0;
    const secondHalfRate = second.length ? second.filter(eligible).length / second.length : 0;
    const observedRate = metrics.sampleSize ? qualifyingCount / metrics.sampleSize : 0;
    const stable = first.length >= 5 && second.length >= 5 && firstHalfRate >= minHalfRate && secondHalfRate >= minHalfRate;
    const evidenceScore = Math.round((observedRate * 0.5 + firstHalfRate * 0.25 + secondHalfRate * 0.25) * 100);
    return {
        barrier, qualifyingCount, nonQualifyingCount: metrics.sampleSize - qualifyingCount,
        observedRate, firstHalfRate, secondHalfRate, evidenceScore, stable,
        qualifies: metrics.sampleSize >= 30 && observedRate >= minObservedRate && stable,
    };
};
