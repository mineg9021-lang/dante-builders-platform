import { extractFinalDigit, normalizeDerivQuote, processDerivTick } from './precision-processor';
import { TickValidator } from './tick-validator';
import { calculateParityStatistics } from './parity-statistics';
import { ParityStateMachine } from './state-machine';

describe('PRIME parity precision processor', () => {
    it('preserves trailing zeros and extracts the final precision digit', () => {
        expect(normalizeDerivQuote('123.40', 2)).toBe('123.40');
        expect(extractFinalDigit('123.40', 2)).toBe(0);
        expect(extractFinalDigit('123.45', 2)).toBe(5);
    });
    it('rejects precision mismatches rather than truncating quotes', () => {
        expect(normalizeDerivQuote('123.456', 2)).toBeNull();
        expect(processDerivTick({ symbol: 'R_10', quote: '100.01', epoch: 100, pip_size: 2 })?.parity).toBe('ODD');
    });
});

describe('PRIME parity tick validator', () => {
    it('accepts increasing ticks per symbol and rejects duplicates and out-of-order ticks', () => {
        const validator = new TickValidator();
        const tick = processDerivTick({ symbol: 'R_10', quote: '100.1', epoch: 100, pip_size: 1 })!;
        expect(validator.validate(tick, 100)).toBe(true);
        expect(validator.validate(tick, 100)).toBe(false);
        const older = { ...tick, epoch: 99 };
        expect(validator.validate(older, 100)).toBe(false);
    });
    it('keeps symbol streams independent and rejects stale ticks', () => {
        const validator = new TickValidator(15);
        const first = processDerivTick({ symbol: 'R_10', quote: '100.1', epoch: 100, pip_size: 1 })!;
        const other = processDerivTick({ symbol: 'R_25', quote: '200.2', epoch: 100, pip_size: 1 })!;
        expect(validator.validate(first, 100)).toBe(true);
        expect(validator.validate(other, 100)).toBe(true);
        expect(validator.validate({ ...first, epoch: 80 }, 100)).toBe(false);
    });
});

describe('PRIME parity statistics', () => {
    it('reports historical frequency and stability without calling it a forecast', () => {
        const ticks = Array.from({ length: 10 }, (_, i) => ({ symbol: 'R_10', quote: String(i), epoch: i + 1, precision: 0, digit: i % 2 === 0 ? 2 : 1, parity: i % 2 === 0 ? 'EVEN' as const : 'ODD' as const }));
        const stats = calculateParityStatistics(ticks, 10);
        expect(stats.sampleSize).toBe(10);
        expect(stats.evenPercent).toBe(50);
        expect(stats.oddPercent).toBe(50);
        expect(stats.observedLead).toBe('NONE');
        expect(stats.stable).toBe(false);
    });
});

describe('PRIME parity state machine', () => {
    it('blocks a restart while a purchased contract is unresolved', () => {
        const machine = new ParityStateMachine();
        machine.transition('CONNECTING');
        machine.transition('COLLECTING');
        machine.transition('ANALYZING');
        machine.transition('EVALUATING');
        machine.transition('READY');
        machine.transition('PURCHASING');
        machine.transition('MONITORING');
        expect(machine.contractUnresolved).toBe(true);
        expect(machine.canTransition('COLLECTING')).toBe(false);
        expect(() => machine.transition('COLLECTING')).toThrow('INVALID_PARITY_STATE_TRANSITION');
    });
});
