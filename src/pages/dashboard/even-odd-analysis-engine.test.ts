import { analyseParity, extractLastDigit, validateTick } from './even-odd-analysis-engine';

describe('Even/Odd analysis engine', () => {
    it('uses the configured quote precision, including trailing zeros', () => {
        expect(extractLastDigit(123.45, 2)).toBe(5);
        expect(extractLastDigit('123.4500', 2)).toBe(5);
        expect(extractLastDigit('123.4', 2)).toBe(0);
    });

    it('rejects malformed quotes and duplicate or out-of-order ticks', () => {
        expect(extractLastDigit('not-a-quote', 2)).toBeNull();
        expect(validateTick('R_10', '123.45', 100, 2, 100, 100).reason).toBe(
            'DUPLICATE_OR_OUT_OF_ORDER'
        );
    });

    it('rejects stale ticks', () => {
        expect(validateTick('R_10', '123.45', 80, 2, undefined, 100).reason).toBe('STALE_TICK');
    });

    it('waits when the sample is too small', () => {
        expect(analyseParity([2, 4, 6, 8, 0]).decision).toBe('WAIT');
    });

    it('labels a large historical parity imbalance as a candidate, not a forecast', () => {
        const result = analyseParity([...Array(24).fill(2), ...Array(6).fill(1)]);
        expect(result.decision).toBe('CANDIDATE');
        expect(result.lead).toBe('EVEN');
        expect(result.evidenceScore).toBe(60);
    });
});
