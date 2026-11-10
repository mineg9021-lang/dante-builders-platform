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

    it('keeps Even and Odd as separate contract-aware parity robots', () => {
        const parityTicks = (targetEven: boolean): StrategyTick[] =>
            Array.from({ length: 40 }, (_, index) => {
                const withinHalf = index % 20;
                const matchesParity = withinHalf < 12;
                const isEven = matchesParity ? targetEven : !targetEven;
                const digit = isEven ? 2 : 1;
                return {
                    symbol: 'R_100',
                    quote: `100.0${digit}`,
                    epoch: 1_800_000_000 - 39 + index,
                    digit,
                };
            });

        const even = evaluateBotStrategy({
            symbol: 'R_100',
            ticks: parityTicks(true),
            config: { id: 'EVEN', minSample: 40, maxSample: 40 },
            nowSeconds: 1_800_000_000,
        });
        const odd = evaluateBotStrategy({
            symbol: 'R_100',
            ticks: parityTicks(false),
            config: { id: 'ODD', minSample: 40, maxSample: 40 },
            nowSeconds: 1_800_000_000,
        });

        expect(even.decision).toBe('READY');
        expect(even.contractType).toBe('DIGITEVEN');
        expect(even.proposalFields).not.toHaveProperty('barrier');
        expect(odd.decision).toBe('READY');
        expect(odd.contractType).toBe('DIGITODD');
        expect(odd.proposalFields).not.toHaveProperty('barrier');
    });

    it('keeps parity robots in WAIT when the full-window or split-window evidence is weak', () => {
        const weakParityTicks: StrategyTick[] = Array.from({ length: 40 }, (_, index) => {
            const isEven = index < 20 ? index < 11 : index < 31;
            const digit = isEven ? 2 : 1;
            return {
                symbol: 'R_100',
                quote: `100.0${digit}`,
                epoch: 1_800_000_000 - 39 + index,
                digit,
            };
        });

        const even = evaluateBotStrategy({
            symbol: 'R_100',
            ticks: weakParityTicks,
            config: { id: 'EVEN', minSample: 40, maxSample: 40 },
            nowSeconds: 1_800_000_000,
        });
        const odd = evaluateBotStrategy({
            symbol: 'R_100',
            ticks: weakParityTicks,
            config: { id: 'ODD', minSample: 40, maxSample: 40 },
            nowSeconds: 1_800_000_000,
        });

        expect(even.decision).toBe('WAIT');
        expect(odd.decision).toBe('WAIT');
        expect(even.contractType).toBe('DIGITEVEN');
        expect(odd.contractType).toBe('DIGITODD');
    });


describe('directional and barrier Robot coverage', () => {
    it('requires falling momentum for Fall and consecutive down ticks for Only Down', () => {
        const falling = makeTicks(Array.from({ length: 14 }, (_, index) => 120 - index));
        const fall = evaluateBotStrategy({ symbol: 'R_100', ticks: falling, config: { id: 'FALL', minSample: 12 }, nowSeconds: 1_800_000_000 });
        const onlyDown = evaluateBotStrategy({ symbol: 'R_100', ticks: falling, config: { id: 'ONLY_DOWN', runLength: 5 }, nowSeconds: 1_800_000_000 });
        expect(fall.decision).toBe('READY');
        expect(fall.contractType).toBe('PUT');
        expect(onlyDown.decision).toBe('READY');
        expect(onlyDown.contractType).toBe('RUNLOW');
    });

    it('requires downward momentum and below-average confirmation for Asian Down', () => {
        const falling = makeTicks(Array.from({ length: 14 }, (_, index) => 120 - index));
        const result = evaluateBotStrategy({ symbol: 'R_100', ticks: falling, config: { id: 'ASIAN_DOWN' }, nowSeconds: 1_800_000_000 });
        expect(result.decision).toBe('READY');
        expect(result.contractType).toBe('ASIAND');
    });

    it('maps Over and Under barriers to the requested Deriv contracts', () => {
        const makeDigitTicks = (digits: number[]): StrategyTick[] => digits.map((digit, index) => ({
            symbol: 'R_100', quote: `100.0${digit}`, epoch: 1_800_000_000 - digits.length + index + 1, digit,
        }));
        const over = evaluateBotStrategy({
            symbol: 'R_100', ticks: makeDigitTicks(Array.from({ length: 20 }, (_, index) => 6 + index % 4)),
            config: { id: 'DIGIT_OVER', minSample: 12, barrier: 4 }, nowSeconds: 1_800_000_000,
        });
        const under = evaluateBotStrategy({
            symbol: 'R_100', ticks: makeDigitTicks(Array.from({ length: 20 }, (_, index) => index % 4)),
            config: { id: 'DIGIT_UNDER', minSample: 12, barrier: 4 }, nowSeconds: 1_800_000_000,
        });
        expect(over.decision).toBe('READY');
        expect(over.contractType).toBe('DIGITOVER');
        expect(over.proposalFields).toMatchObject({ barrier: '4' });
        expect(under.decision).toBe('READY');
        expect(under.contractType).toBe('DIGITUNDER');
        expect(under.proposalFields).toMatchObject({ barrier: '4' });
    });

    it('rejects a stale latest tick without discarding fresh historical samples', () => {
        const ticks = makeTicks(Array.from({ length: 14 }, (_, index) => 100 + index), 1_800_000_000 - 100);
        const stale = evaluateBotStrategy({ symbol: 'R_100', ticks, config: { id: 'RISE', minSample: 12 }, nowSeconds: 1_800_000_000 });
        expect(stale.decision).toBe('WAIT');
        expect(stale.sampleSize).toBe(0);
    });
});
