import { analyzeDigitTicks, extractLastDigit, quoteWithPrecision } from './digit-matches-engine';

describe('Digit Matches scanner processing', () => {
    it('preserves trailing decimal zeroes using market precision', () => {
        expect(quoteWithPrecision('123.45', 3)).toBe('123.450');
        expect(extractLastDigit('123.450')).toBe(0);
    });

    it('extracts the final digit for integer-precision quotes', () => {
        expect(extractLastDigit('123')).toBe(3);
    });

    it('counts all ten digits and parity observations', () => {
        const ticks = Array.from({ length: 20 }, (_, digit) => ({
            symbol: 'R_10',
            quote: `100.0${digit % 10}`,
            digit: digit % 10,
            epoch: 1000 + digit,
        }));
        const report = analyzeDigitTicks({ ticks, windowSize: 20, minSample: 20 });
        expect(report.sampleSize).toBe(20);
        expect(report.digits).toHaveLength(10);
        expect(report.even).toBe(10);
        expect(report.odd).toBe(10);
        expect(report.matches).toHaveLength(10);
        expect(report.differs).toHaveLength(10);
    });

    it('does not qualify candidates before the minimum sample', () => {
        const report = analyzeDigitTicks({
            ticks: [{ symbol: 'R_10', quote: '1.2', digit: 2, epoch: 1 }],
            windowSize: 100,
            minSample: 100,
        });
        expect(report.matches.every(candidate => candidate.status === 'INSUFFICIENT DATA')).toBe(true);
    });
});
