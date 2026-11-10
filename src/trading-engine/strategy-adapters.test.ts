import { evaluateBotStrategy, type StrategyTick } from './strategy-adapters';

const makeTicks = (quotes: number[], now = 1_800_000_000): StrategyTick[] =>
    quotes.map((value, index) => ({
        symbol: 'R_100',
        quote: value.toFixed(2),
        epoch: now - (quotes.length - index - 1),
        digit: Number(value.toFixed(2).slice(-1)),
    }));

describe('specialist strategy adapters', () => {
    it('maps Rise to CALL and requires directional momentum', () => {
        const ticks = makeTicks(Array.from({ length: 14 }, (_, i) => 100 + i));
        const result = evaluateBotStrategy({ symbol: 'R_100', ticks, config: { id: 'RISE', minSample: 12 }, nowSeconds: 1_800_000_000 });
        expect(result.decision).toBe('READY');
        expect(result.contractType).toBe('CALL');
    });

    it('maps Only Up to RUNHIGH and rejects equal or falling ticks', () => {
        const rising = makeTicks(Array.from({ length: 12 }, (_, i) => 100 + i));
        const ready = evaluateBotStrategy({ symbol: 'R_100', ticks: rising, config: { id: 'ONLY_UP', runLength: 5 }, nowSeconds: 1_800_000_000 });
        expect(ready.contractType).toBe('RUNHIGH');
        expect(ready.decision).toBe('READY');
        const interrupted = [...rising.slice(0, -1), { ...rising[rising.length - 1], quote: '110.00' }];
        const wait = evaluateBotStrategy({ symbol: 'R_100', ticks: interrupted, config: { id: 'ONLY_UP', runLength: 5 }, nowSeconds: 1_800_000_000 });
        expect(wait.decision).toBe('WAIT');
    });

    it('maps Asian Up and Down to Deriv contract identifiers', () => {
        const rising = makeTicks(Array.from({ length: 14 }, (_, i) => 100 + i));
        const up = evaluateBotStrategy({ symbol: 'R_100', ticks: rising, config: { id: 'ASIAN_UP' }, nowSeconds: 1_800_000_000 });
        expect(up.contractType).toBe('ASIANU');
        expect(up.decision).toBe('READY');
    });

    it('passes Matches and Differs digit candidates as Deriv barrier strings', () => {
        const ticks = Array.from({ length: 40 }, (_, index) => ({
            symbol: 'R_100',
            quote: (100 + index / 100).toFixed(2),
            epoch: 1_800_000_000 - 39 + index,
            digit: index % 10,
        }));
        const matches = evaluateBotStrategy({
            symbol: 'R_100', ticks,
            config: { id: 'DIGIT_MATCH', minSample: 12, prediction: 7 },
            nowSeconds: 1_800_000_000,
        });
        const differs = evaluateBotStrategy({
            symbol: 'R_100', ticks,
            config: { id: 'DIGIT_DIFFERS', minSample: 12, prediction: 7 },
            nowSeconds: 1_800_000_000,
        });
        expect(matches.decision).toBe('READY');
        expect(matches.proposalFields).toMatchObject({ barrier: '7' });
        expect(differs.decision).toBe('READY');
        expect(differs.proposalFields).toMatchObject({ barrier: '7' });
        expect(matches.proposalFields).not.toHaveProperty('prediction');
        expect(differs.proposalFields).not.toHaveProperty('prediction');
    });

    it('does not authorise a trade from an incomplete sample', () => {
        const result = evaluateBotStrategy({ symbol: 'R_100', ticks: makeTicks([100, 101, 102]), config: { id: 'FALL' }, nowSeconds: 1_800_000_000 });
        expect(result.decision).toBe('WAIT');
    });
});
