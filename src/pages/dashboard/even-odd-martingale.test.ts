import { advanceMartingaleAfterSettlement, calculateParityStake, MAX_MARTINGALE_STEPS } from './even-odd-martingale';

describe('parity Martingale progression safety', () => {
    it('keeps the base stake when Martingale is disabled', () => {
        expect(calculateParityStake(2, false, 2)).toBe(2);
    });

    it('calculates the 1.5x progression and caps the configured steps', () => {
        expect(calculateParityStake(2, true, 0)).toBe(2);
        expect(calculateParityStake(2, true, 1)).toBe(3);
        expect(calculateParityStake(2, true, 2)).toBe(4.5);
        expect(calculateParityStake(2, true, 3)).toBe(6.75);
        expect(calculateParityStake(2, true, 99)).toBe(6.75);
        expect(MAX_MARTINGALE_STEPS).toBe(3);
    });

    it('resets progression after a win or void settlement', () => {
        expect(advanceMartingaleAfterSettlement(2, 'WON', true)).toEqual({ nextStep: 0, halt: false });
        expect(advanceMartingaleAfterSettlement(2, 'VOID', true)).toEqual({ nextStep: 0, halt: false });
    });

    it('advances on losses and halts after the final raised-stake loss', () => {
        expect(advanceMartingaleAfterSettlement(0, 'LOST', true)).toEqual({ nextStep: 1, halt: false });
        expect(advanceMartingaleAfterSettlement(1, 'LOST', true)).toEqual({ nextStep: 2, halt: false });
        expect(advanceMartingaleAfterSettlement(2, 'LOST', true)).toEqual({ nextStep: 3, halt: false });
        expect(advanceMartingaleAfterSettlement(3, 'LOST', true)).toEqual({ nextStep: 0, halt: true });
    });

    it('never advances or halts when Martingale is disabled', () => {
        expect(advanceMartingaleAfterSettlement(2, 'LOST', false)).toEqual({ nextStep: 0, halt: false });
    });
});
