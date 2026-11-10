import { runRobot18LayerEngine, ROBOT_ENGINE_LAYERS } from './robot-18-layer-engine';
import type { BotStrategyConfig, StrategyDecisionResult, StrategyTick } from './strategy-adapters';
import type { ExecutionRiskContext } from './execution';

const now = Math.floor(Date.now() / 1000);
const sample: StrategyTick[] = Array.from({ length: 12 }, (_, index) => ({
    symbol: 'R_100',
    quote: '100.02',
    epoch: now - 11 + index,
    digit: 2,
}));
const config: BotStrategyConfig = { id: 'EVEN', minSample: 12, maxSample: 12 };
const decision: StrategyDecisionResult = {
    decision: 'READY',
    contractType: 'DIGITEVEN',
    proposalFields: { duration: 5, duration_unit: 't' },
    sampleSize: 12,
    evidenceScore: 60,
    reason: 'Test fixture',
    opportunityKey: 'EVEN:R_100:' + now,
};
const risk: ExecutionRiskContext = {
    mode: 'demo',
    authorized: true,
    isVirtual: true,
    liveTradingConfirmed: false,
    strategyDecision: 'READY',
    lastTickEpoch: now,
    stake: 1,
    balance: 100,
    maxStake: 5,
    maxStakePercent: 5,
    sessionPnl: 0,
    stopLoss: 10,
    takeProfit: 10,
    tradesThisSession: 0,
    maxTradesPerSession: 10,
};
const run = (overrides: Partial<{
    symbol: string;
    tick: StrategyTick;
    previous: StrategyTick;
    sample: StrategyTick[];
    config: BotStrategyConfig;
    decision: StrategyDecisionResult;
    contractAvailable: boolean;
    risk: ExecutionRiskContext;
}> = {}) => runRobot18LayerEngine({
    symbol: 'R_100',
    tick: sample[sample.length - 1],
    previous: sample[sample.length - 2],
    sample,
    config,
    decision,
    contractAvailable: true,
    risk,
    ...overrides,
});

describe('shared 18-layer Robot engine', () => {
    it('requires all 18 ordered checks to pass before execution', () => {
        const report = run();
        expect(ROBOT_ENGINE_LAYERS).toHaveLength(18);
        expect(report.passed).toBe(true);
        expect(report.passedLayers).toBe(18);
        expect(report.totalLayers).toBe(18);
        expect(report.layers.map(layer => layer.name)).toEqual(ROBOT_ENGINE_LAYERS);
    });

    it.each([
        ['MARKET_SCOPE', { symbol: 'R_50' }],
        ['DECIMAL_INTEGRITY', { tick: { ...sample[11], digit: 9 } }],
        ['SEQUENCE_ORDER', { previous: sample[11] }],
        ['SAMPLE_WINDOW', { sample: Array.from({ length: 201 }, (_, index) => ({ ...sample[0], epoch: now - 201 + index })) }],
        ['SAMPLE_MINIMUM', { sample: sample.slice(-5) }],
        ['PATTERN_ANALYSIS', { decision: { ...decision, decision: 'WAIT' as const } }],
        ['STRATEGY_EVIDENCE', { decision: { ...decision, evidenceScore: 7 } }],
        ['CONTRACT_MAPPING', { decision: { ...decision, contractType: 'UNSUPPORTED' as any } }],
        ['CONTRACT_AVAILABILITY', { contractAvailable: false }],
        ['OPPORTUNITY_IDENTITY', { decision: { ...decision, opportunityKey: '   ' } }],
        ['ACCOUNT_AUTHORIZATION', { risk: { ...risk, authorized: false } }],
        ['RISK_PERMISSION', { risk: { ...risk, balance: Number.POSITIVE_INFINITY } }],
    ] as const)('blocks when %s fails', (layer, overrides) => {
        const report = run(overrides as any);
        expect(report.passed).toBe(false);
        expect(report.blockedAt).toBe(layer);
    });

    it('rejects digit contracts with missing or out-of-range barriers', () => {
        const missingBarrier = run({
            decision: { ...decision, contractType: 'DIGITMATCH', proposalFields: { duration: 5, duration_unit: 't' } },
        });
        const invalidOverBarrier = run({
            decision: { ...decision, contractType: 'DIGITOVER', proposalFields: { duration: 5, duration_unit: 't', barrier: '9' } },
        });
        expect(missingBarrier.blockedAt).toBe('CONTRACT_MAPPING');
        expect(invalidOverBarrier.blockedAt).toBe('CONTRACT_MAPPING');
    });


    it('accepts a valid digit barrier contract mapping', () => {
        const report = run({
            decision: {
                ...decision,
                contractType: 'DIGITOVER',
                proposalFields: { duration: 5, duration_unit: 't', barrier: '4' },
            },
        });
        expect(report.passed).toBe(true);
        expect(report.layers.find(layer => layer.name === 'CONTRACT_MAPPING')?.passed).toBe(true);
    });

    it('blocks an abrupt single-tick price shock at MARKET_STABILITY', () => {
        const shocked = sample.map((tick, index) => index === 11 ? { ...tick, quote: '101.02' } : tick);
        const report = run({ sample: shocked, tick: shocked[11] });
        expect(report.passed).toBe(false);
        expect(report.blockedAt).toBe('MARKET_STABILITY');
    });

    it('blocks an excessive five-tick price range even without one large jump', () => {
        const prices = ['100.00', '100.30', '100.60', '100.90', '101.20'];
        const ranged = sample.map((tick, index) => index < 7 ? tick : {
            ...tick,
            quote: prices[index - 7],
            digit: Number(prices[index - 7].slice(-1)),
        });
        const report = run({ sample: ranged, tick: ranged[11] });
        expect(report.passed).toBe(false);
        expect(report.blockedAt).toBe('MARKET_STABILITY');
    });

    it('blocks malformed historical prices inside the stability window', () => {
        const malformed = sample.map((tick, index) => index === 8 ? { ...tick, quote: '1e2' } : tick);
        const report = run({ sample: malformed, tick: malformed[11] });
        expect(report.passed).toBe(false);
        expect(report.blockedAt).toBe('MARKET_STABILITY');
    });

    it('allows a calm five-tick price range', () => {
        const calm = sample.map((tick, index) => index < 7 ? tick : {
            ...tick,
            quote: ['100.02', '100.03', '100.01', '100.02', '100.02'][index - 7],
            digit: 2,
        });
        const report = run({ sample: calm, tick: calm[11] });
        expect(report.passed).toBe(true);
        expect(report.layers.find(layer => layer.name === 'MARKET_STABILITY')?.passed).toBe(true);
    });

    it('rejects a malformed quote without throwing', () => {
        const report = run({ tick: { ...sample[11], quote: undefined as any } });
        expect(report.passed).toBe(false);
        expect(report.blockedAt).toBe('TICK_SCHEMA');
    });
});
