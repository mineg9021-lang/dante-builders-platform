import type { ProcessedParityTick } from './precision-processor';

export type TickValidationResult = { accepted: ProcessedParityTick[]; rejected: number; reason: string | null };

/** Per-symbol ordering and duplicate protection. A tick epoch is unique within a symbol stream. */
export class TickValidator {
    private readonly lastEpochBySymbol = new Map<string, number>();
    constructor(private readonly maxAgeSeconds = 15, private readonly futureToleranceSeconds = 5) {}

    validate(tick: ProcessedParityTick, nowSeconds: number): boolean {
        if (!Number.isFinite(nowSeconds) || !Number.isFinite(tick.epoch)) return false;
        if (tick.epoch > nowSeconds + this.futureToleranceSeconds || nowSeconds - tick.epoch > this.maxAgeSeconds) return false;
        const previous = this.lastEpochBySymbol.get(tick.symbol) ?? 0;
        if (tick.epoch <= previous) return false;
        this.lastEpochBySymbol.set(tick.symbol, tick.epoch);
        return true;
    }

    reset(symbol?: string): void {
        if (symbol) this.lastEpochBySymbol.delete(symbol);
        else this.lastEpochBySymbol.clear();
    }
}
