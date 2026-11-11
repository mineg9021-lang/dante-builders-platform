import type { ProcessedParityTick } from './precision-processor';

export type ParityStatistics = { sampleSize: number; even: number; odd: number; evenPercent: number; oddPercent: number; observedLead: 'EVEN' | 'ODD' | 'NONE'; observedLeadPercent: number; firstHalfLead: 'EVEN' | 'ODD' | 'NONE'; secondHalfLead: 'EVEN' | 'ODD' | 'NONE'; stable: boolean; digitFrequencies: number[] };
const lead = (ticks: ProcessedParityTick[]): 'EVEN' | 'ODD' | 'NONE' => {
    const even = ticks.filter(t => t.parity === 'EVEN').length;
    const odd = ticks.length - even;
    return even === odd || !ticks.length ? 'NONE' : even > odd ? 'EVEN' : 'ODD';
};

/** Descriptive historical statistics only. These are not probabilities of the next tick. */
export const calculateParityStatistics = (ticks: ProcessedParityTick[], windowSize = 30): ParityStatistics => {
    const sample = ticks.slice(-Math.max(1, Math.floor(windowSize)));
    const even = sample.filter(t => t.parity === 'EVEN').length;
    const odd = sample.length - even;
    const midpoint = Math.floor(sample.length / 2);
    const firstHalfLead = lead(sample.slice(0, midpoint));
    const secondHalfLead = lead(sample.slice(midpoint));
    const observedLead = lead(sample);
    const digitFrequencies = Array.from({ length: 10 }, (_, digit) => sample.filter(t => t.digit === digit).length);
    return {
        sampleSize: sample.length, even, odd,
        evenPercent: sample.length ? even / sample.length * 100 : 0,
        oddPercent: sample.length ? odd / sample.length * 100 : 0,
        observedLead,
        observedLeadPercent: sample.length ? Math.abs(even - odd) / sample.length * 100 : 0,
        firstHalfLead, secondHalfLead,
        stable: firstHalfLead !== 'NONE' && firstHalfLead === secondHalfLead,
        digitFrequencies,
    };
};
