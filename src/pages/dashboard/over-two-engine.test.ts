import { runOverTwoPipeline, type OverTwoTick, type OverTwoConfig } from './over-two-engine';

const config = (overrides: Partial<OverTwoConfig> = {}): OverTwoConfig => ({
    mode: 'demo', armed: true, authorized: true, demoAccount: true, stake: 1, balance: 100,
    stopLoss: 10, takeProfit: 10, sessionLoss: 0, sessionProfit: 0, tradesThisSession: 0,
    maxTradesPerSession: 10, minSample: 30, maxTicks: 60, minOverRate: 0.7, minHalfRate: 0.6,
    ...overrides,
});
const ticks = (digits: number[]): OverTwoTick[] => digits.map((digit, i) => ({
    symbol: 'R_100', quote: '100.0' + digit, epoch: 1_800_000_000 + i, digit,
}));

describe('Over 2 strategy pipeline', () => {
    it('requires a sufficient stable sample and explicit demo permission', () => {
        const result = runOverTwoPipeline({
            symbol: 'R_100',
            ticks: ticks(Array.from({ length: 30 }, (_, i) => i % 10 < 8 ? 8 : 1)),
            config: config(),
            nowSeconds: 1_800_000_030,
        });
        expect(result.contractType).toBe('DIGITOVER');
        expect(result.barrier).toBe('2');
        expect(result.stages).toHaveLength(18);
        expect(result.sampleSize).toBe(30);
        expect(result.executionAuthorized).toBe(true);
        expect(result.status).toBe('READY');
    });

    it('waits when the sample does not show a qualifying Over 2 distribution', () => {
        const result = runOverTwoPipeline({
            symbol: 'R_100',
            ticks: ticks(Array.from({ length: 30 }, (_, i) => i % 10 < 5 ? 1 : 8)),
            config: config(),
            nowSeconds: 1_800_000_030,
        });
        expect(result.status).toBe('WAIT');
        expect(result.executionAuthorized).toBe(false);
    });

    it('rejects a stake above the 2 percent balance cap', () => {
        const result = runOverTwoPipeline({
            symbol: 'R_100',
            ticks: ticks(Array.from({ length: 30 }, () => 8)),
            config: config({ stake: 3 }),
            nowSeconds: 1_800_000_030,
        });
        expect(result.status).toBe('REJECTED');
    });

    it('never authorises analysis-only mode', () => {
        const result = runOverTwoPipeline({
            symbol: 'R_100',
            ticks: ticks(Array.from({ length: 30 }, () => 8)),
            config: config({ mode: 'analysis', armed: false }),
            nowSeconds: 1_800_000_030,
        });
        expect(result.executionAuthorized).toBe(false);
    });
});
