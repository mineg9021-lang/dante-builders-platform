import { calculateDigitMetrics } from './market-metrics-engine';
import { scoreDigitBarrier } from './prediction-scoring-engine';

describe('background market metrics and prediction scoring', () => {
    it('calculates digit counts, entropy, streaks and transitions from valid observations', () => {
        const metrics = calculateDigitMetrics([8, 8, 1, 8, 1, 8, 8, 1]);
        expect(metrics.sampleSize).toBe(8);
        expect(metrics.counts[8]).toBe(5);
        expect(metrics.longestStreak).toBe(2);
        expect(metrics.transitionCount).toBe(7);
        expect(metrics.entropyBits).toBeGreaterThan(0);
    });

    it('scores a stable Over 2 sample without calling the score a probability', () => {
        const digits = Array.from({ length: 30 }, (_, i) => i % 10 < 8 ? 8 : 1);
        const metrics = calculateDigitMetrics(digits);
        const evidence = scoreDigitBarrier(digits, metrics, 2, 0.7, 0.6);
        expect(evidence.qualifies).toBe(true);
        expect(evidence.observedRate).toBe(0.8);
        expect(evidence.evidenceScore).toBe(80);
        expect(evidence.stable).toBe(true);
    });

    it('rejects a weak sample and invalid digit values', () => {
        const digits = Array.from({ length: 30 }, (_, i) => i % 2 ? 8 : 1);
        const metrics = calculateDigitMetrics([...digits, -1, 10]);
        const evidence = scoreDigitBarrier(digits, metrics, 2, 0.7, 0.6);
        expect(metrics.sampleSize).toBe(30);
        expect(evidence.qualifies).toBe(false);
    });
});
