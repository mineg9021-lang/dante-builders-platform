import {
    runParityPipeline,
    validateSettlement,
    type EngineTick,
    type ParityEngineConfig,
} from './even-odd-parity-engine';

const now = 1_000;
const makeTicks = (): EngineTick[] =>
    Array.from({ length: 30 }, (_, index) => {
        const digit = index % 3 === 0 || index % 3 === 1 ? 2 : 1;
        return {
            symbol: 'R_10',
            quote: `100.0${digit}`,
            epoch: 971 + index,
            digit,
            parity: digit % 2 === 0 ? 'EVEN' : 'ODD',
        };
    });

const config = (overrides: Partial<ParityEngineConfig> = {}): ParityEngineConfig => ({
    mode: 'analysis',
    armed: false,
    authorized: false,
    demoAccount: true,
    maxTicks: 30,
    minSample: 30,
    minLead: 0.12,
    minStableRatio: 1,
    stake: 1,
    availableBalance: 100,
    maxStakePercent: 2,
    sessionLoss: 0,
    sessionProfit: 0,
    tradesThisSession: 0,
    maxTradesPerSession: 10,
    stopLoss: 10,
    takeProfit: 10,
    ...overrides,
});

describe('18-layer parity decision engine', () => {
    it('runs all 18 stages and keeps analysis mode from authorizing orders', () => {
        const result = runParityPipeline({
            symbol: 'R_10',
            ticks: makeTicks(),
            config: config(),
            nowSeconds: now,
            startedAt: 900,
        });

        expect(result.stages).toHaveLength(18);
        expect(result.selectedParity).toBe('EVEN');
        expect(result.sampleSize).toBe(30);
        expect(result.executionAuthorized).toBe(false);
        expect(result.status).toBe('WAIT');
        expect(result.journal.status).toBe('WAIT');
    });

    it('authorizes only an explicitly armed, authenticated demo setup after every gate passes', () => {
        const result = runParityPipeline({
            symbol: 'R_10',
            ticks: makeTicks(),
            config: config({ mode: 'demo', armed: true, authorized: true, demoAccount: true }),
            nowSeconds: now,
        });

        expect(result.executionAuthorized).toBe(true);
        expect(result.status).toBe('READY');
        expect(result.contractType).toBe('DIGITEVEN');
    });

    it('blocks risk when the configured stake exceeds the exposure cap', () => {
        const result = runParityPipeline({
            symbol: 'R_10',
            ticks: makeTicks(),
            config: config({ mode: 'demo', armed: true, authorized: true, stake: 5 }),
            nowSeconds: now,
        });

        expect(result.executionAuthorized).toBe(false);
        expect(result.stages[13].status).toBe('BLOCKED');
    });

    it('blocks new entries when the session take-profit has been reached', () => {
        const result = runParityPipeline({
            symbol: 'R_10',
            ticks: makeTicks(),
            config: config({ mode: 'demo', armed: true, authorized: true, sessionProfit: 10, takeProfit: 10 }),
            nowSeconds: now,
        });

        expect(result.executionAuthorized).toBe(false);
        expect(result.stages[13].status).toBe('BLOCKED');
    });

    it('blocks entries after the configured per-session trade limit', () => {
        const result = runParityPipeline({
            symbol: 'R_10',
            ticks: makeTicks(),
            config: config({ mode: 'demo', armed: true, authorized: true, tradesThisSession: 10, maxTradesPerSession: 10 }),
            nowSeconds: now,
        });

        expect(result.executionAuthorized).toBe(false);
        expect(result.stages[13].status).toBe('BLOCKED');
    });

    it('waits when the sample is too small or the tick data is stale', () => {
        const short = runParityPipeline({
            symbol: 'R_10',
            ticks: makeTicks().slice(0, 10),
            config: config(),
            nowSeconds: now,
        });
        const staleTicks = makeTicks().map(tick => ({ ...tick, epoch: 100 }));
        const stale = runParityPipeline({
            symbol: 'R_10',
            ticks: staleTicks,
            config: config(),
            nowSeconds: now,
        });

        expect(short.status).toBe('WAIT');
        expect(stale.sampleSize).toBe(30);
        expect(stale.executionAuthorized).toBe(false);
        expect(stale.stages[11].status).toBe('WAIT');
    });

    it('accepts only verified settlement states', () => {
        expect(validateSettlement({ status: 'won', profit: '2.5' })).toEqual({ status: 'WON', profit: 2.5 });
        expect(validateSettlement({ status: 'open', profit: 0 })).toBeNull();
        expect(validateSettlement(undefined)).toBeNull();
    });
});
