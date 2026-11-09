import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import './even-odd-ai-dashboard.scss';

type TSymbol = {
    symbol: string;
    display_name?: string;
    underlying_symbol?: string;
    pip_size?: number;
};

type TTickRecord = { epoch: number; quote: string; digit: number };

type TMarketState = {
    symbol: string;
    name: string;
    ticks: TTickRecord[];
    lastEpoch: number;
    status: 'WAIT' | 'READY' | 'REJECTED';
    parity: 'EVEN' | 'ODD' | null;
    evidence: number;
};

const SAMPLE_SIZE = 30;
const MAX_TICKS = 100;
const MIN_EVIDENCE = 20;

const getPrecision = (symbol: TSymbol) => {
    const configured = api_base.pip_sizes?.[symbol.symbol];
    if (Number.isInteger(configured) && configured >= 0 && configured <= 10) return configured;
    const pip = Number(symbol.pip_size);
    if (pip > 0) return Math.max(0, Math.min(10, Math.round(-Math.log10(pip))));
    return null;
};

const getVolatilitySymbols = (): TSymbol[] => {
    const symbols = (api_base.active_symbols || []) as TSymbol[];
    return symbols.filter(item => {
        const code = item.symbol || item.underlying_symbol || '';
        const name = item.display_name || item.underlying_symbol || '';
        return code.startsWith('R_') && /volatility/i.test(name);
    });
};

const scoreMarket = (market: TMarketState): TMarketState => {
    if (market.ticks.length < SAMPLE_SIZE) {
        return { ...market, status: 'WAIT', parity: null, evidence: 0 };
    }
    const sample = market.ticks.slice(-SAMPLE_SIZE);
    const even = sample.filter(tick => tick.digit % 2 === 0).length;
    const odd = sample.length - even;
    const gap = Math.abs(even - odd);
    const evidence = Math.round((gap / sample.length) * 100);
    if (evidence < MIN_EVIDENCE) {
        return { ...market, status: 'WAIT', parity: null, evidence };
    }
    return {
        ...market,
        status: 'READY',
        parity: even > odd ? 'EVEN' : 'ODD',
        evidence,
    };
};

const EvenOddAiDashboard = observer(() => {
    const { isAuthorized, connectionStatus } = useApiBase();
    const [markets, setMarkets] = useState<TMarketState[]>([]);
    const [isScanning, setIsScanning] = useState(false);
    const [message, setMessage] = useState('Connect and authorize your Deriv account to begin market analysis.');
    const [stake, setStake] = useState('1');
    const [stopLoss, setStopLoss] = useState('10');
    const [takeProfit, setTakeProfit] = useState('5');
    const [recoveryEnabled, setRecoveryEnabled] = useState(false);
    const [lastUpdate, setLastUpdate] = useState('');
    const subscriptions = useRef<Set<string>>(new Set());
    const stream = useRef<{ unsubscribe: () => void } | null>(null);
    const marketCache = useRef<Map<string, TMarketState>>(new Map());

    const readyMarkets = useMemo(
        () => markets.filter(market => market.status === 'READY').sort((a, b) => b.evidence - a.evidence),
        [markets]
    );
    const bestMarket = readyMarkets[0];

    const stopScanning = useCallback(() => {
        if (stream.current) {
            stream.current.unsubscribe();
            stream.current = null;
        }
        subscriptions.current.forEach(id => {
            try {
                api_base.api?.send({ forget: id });
            } catch (error) {
                console.warn('[EvenOdd AI] Unable to forget tick subscription:', error);
            }
        });
        subscriptions.current.clear();
        marketCache.current.clear();
        setIsScanning(false);
    }, []);

    const startScanning = useCallback(() => {
        if (!isAuthorized || !api_base.api || connectionStatus !== 'OPENED') {
            setMessage('Deriv account authorization and an open WebSocket connection are required.');
            return;
        }
        const symbols = getVolatilitySymbols();
        if (!symbols.length) {
            setMessage('No eligible Volatility Index symbols are available from Deriv yet. Please wait for the symbol list to load.');
            return;
        }

        stopScanning();
        const initial = symbols.map(symbol => ({
            symbol: symbol.symbol,
            name: symbol.display_name || symbol.symbol,
            ticks: [],
            lastEpoch: 0,
            status: 'WAIT' as const,
            parity: null,
            evidence: 0,
        }));
        initial.forEach(market => marketCache.current.set(market.symbol, market));
        setMarkets(initial);
        setMessage(`Live analysis started. Listening to ${symbols.length} eligible Volatility Index markets. No trades will be placed.`);
        setIsScanning(true);

        stream.current = api_base.api.onMessage().subscribe(({ data }: any) => {
            if (data?.msg_type !== 'tick' || data?.error || !data?.tick) return;
            const tick = data.tick;
            const subscriptionId = tick?.subscription?.id;
            if (subscriptionId) subscriptions.current.add(String(subscriptionId));
            const symbol = String(tick.symbol || '');
            const current = marketCache.current.get(symbol);
            if (!current) return;

            const epoch = Number(tick.epoch);
            if (!Number.isFinite(epoch) || epoch <= current.lastEpoch) return;

            const precision = getPrecision(symbols.find(item => item.symbol === symbol)!);
            if (precision === null) return;
            const quoteValue = tick.quote;
            const quote = typeof quoteValue === 'string' ? quoteValue : Number(quoteValue).toFixed(precision);
            const digits = quote.replace(/[^0-9]/g, '');
            if (!digits.length) return;
            const digit = Number(digits[digits.length - 1]);
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) return;

            const next = scoreMarket({
                ...current,
                lastEpoch: epoch,
                ticks: [...current.ticks, { epoch, quote, digit }].slice(-MAX_TICKS),
            });
            marketCache.current.set(symbol, next);
            setMarkets(Array.from(marketCache.current.values()));
            setLastUpdate(new Date().toLocaleTimeString());
        });

        symbols.forEach(symbol => {
            try {
                const request = (api_base.api as any)?.send({ ticks: symbol.symbol, subscribe: 1 });
                Promise.resolve(request).then((response: any) => {
                    const subscriptionId = response?.tick?.subscription?.id || response?.subscription?.id;
                    if (!subscriptionId) return;
                    if (marketCache.current.has(symbol.symbol)) {
                        subscriptions.current.add(String(subscriptionId));
                    } else {
                        api_base.api?.send({ forget: String(subscriptionId) });
                    }
                }).catch((error: unknown) => {
                    console.error(`[EvenOdd AI] Tick subscription failed for ${symbol.symbol}:`, error);
                });
            } catch (error) {
                console.error(`[EvenOdd AI] Tick subscription failed for ${symbol.symbol}:`, error);
            }
        });
    }, [connectionStatus, isAuthorized, stopScanning]);

    useEffect(() => () => stopScanning(), [stopScanning]);

    const updateNumber = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        if (value === '' || /^\d+(\.\d{0,2})?$/.test(value)) setter(value);
    };

    return (
        <main className='even-odd-ai'>
            <header className='even-odd-ai__header'>
                <div>
                    <span className='even-odd-ai__eyebrow'>DANTE BUILDERS · INTELLIGENCE</span>
                    <h1>Even / Odd AI</h1>
                    <p>Live market observation, parity analysis and disciplined entry screening.</p>
                </div>
                <div className={`even-odd-ai__connection ${isAuthorized && connectionStatus === 'OPENED' ? 'is-online' : ''}`}>
                    <span />
                    {isAuthorized && connectionStatus === 'OPENED' ? 'DERIV CONNECTED' : 'NOT CONNECTED'}
                </div>
            </header>

            <section className='even-odd-ai__hero'>
                <div className='even-odd-ai__robot' aria-hidden='true'>
                    <div className='even-odd-ai__robot-orbit' />
                    <div className='even-odd-ai__robot-face'>
                        <span className='robot-eye robot-eye--left' />
                        <span className='robot-eye robot-eye--right' />
                        <span className='robot-mouth' />
                    </div>
                    <span className='even-odd-ai__robot-label'>AI CORE</span>
                </div>
                <div className='even-odd-ai__hero-copy'>
                    <span className='even-odd-ai__eyebrow'>MARKET INTELLIGENCE ENGINE</span>
                    <h2>Observe first. Act only with evidence.</h2>
                    <p>The engine validates incoming ticks, preserves quote precision and measures recent Even/Odd distribution. Weak or incomplete samples remain on WAIT.</p>
                    <div className='even-odd-ai__flow'>
                        <span>LIVE TICKS</span><i>→</i><span>VALIDATION</span><i>→</i><span>PARITY ANALYSIS</span><i>→</i><span>ENTRY SCREEN</span>
                    </div>
                </div>
            </section>

            <section className='even-odd-ai__stats'>
                <article><span>MARKETS MONITORED</span><strong>{markets.length}</strong><small>Discovered from Deriv active symbols</small></article>
                <article><span>READY CANDIDATES</span><strong>{readyMarkets.length}</strong><small>Evidence threshold met</small></article>
                <article><span>BEST OBSERVED BIAS</span><strong className={bestMarket?.parity === 'EVEN' ? 'is-even' : bestMarket?.parity === 'ODD' ? 'is-odd' : ''}>{bestMarket?.parity || '—'}</strong><small>{bestMarket ? `${bestMarket.evidence}% distribution gap · not win probability` : 'Waiting for a valid sample'}</small></article>
                <article><span>LAST TICK UPDATE</span><strong className='even-odd-ai__time'>{lastUpdate || '—'}</strong><small>{isScanning ? 'Live stream active' : 'Scanner stopped'}</small></article>
            </section>

            <section className='even-odd-ai__workspace'>
                <div className='even-odd-ai__panel even-odd-ai__scanner'>
                    <div className='even-odd-ai__panel-heading'>
                        <div><span className='even-odd-ai__eyebrow'>BACKGROUND ENGINE</span><h3>Market scanner</h3></div>
                        <span className={`even-odd-ai__status ${isScanning ? 'is-live' : ''}`}>{isScanning ? 'SCANNING' : 'STOPPED'}</span>
                    </div>
                    <p className='even-odd-ai__message'>{message}</p>
                    <div className='even-odd-ai__actions'>
                        <button type='button' onClick={startScanning} disabled={isScanning || !isAuthorized}>Start analysis</button>
                        <button type='button' className='is-secondary' onClick={stopScanning} disabled={!isScanning}>Stop</button>
                    </div>
                    <div className='even-odd-ai__table-wrap'>
                        <table>
                            <thead><tr><th>MARKET</th><th>TICKS</th><th>OBSERVED BIAS</th><th>EVIDENCE GAP</th><th>DECISION</th></tr></thead>
                            <tbody>
                                {markets.length ? markets.map(market => (
                                    <tr key={market.symbol}>
                                        <td><strong>{market.name}</strong><small>{market.symbol}</small></td>
                                        <td>{market.ticks.length}/{SAMPLE_SIZE}</td>
                                        <td className={market.parity === 'EVEN' ? 'is-even' : market.parity === 'ODD' ? 'is-odd' : ''}>{market.parity || '—'}</td>
                                        <td>{market.evidence}%</td>
                                        <td><span className={`even-odd-ai__decision is-${market.status.toLowerCase()}`}>{market.status}</span></td>
                                    </tr>
                                )) : <tr><td colSpan={5} className='even-odd-ai__empty'>Start analysis to discover and monitor eligible Volatility Indices.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>

                <aside className='even-odd-ai__panel even-odd-ai__settings'>
                    <span className='even-odd-ai__eyebrow'>RISK CONFIGURATION</span>
                    <h3>Trade settings</h3>
                    <p className='even-odd-ai__notice'>These values are configuration only. Live purchasing is not enabled in this first integration stage.</p>
                    <label>Stake<input inputMode='decimal' value={stake} onChange={updateNumber(setStake)} /></label>
                    <label>Stop loss<input inputMode='decimal' value={stopLoss} onChange={updateNumber(setStopLoss)} /></label>
                    <label>Take profit<input inputMode='decimal' value={takeProfit} onChange={updateNumber(setTakeProfit)} /></label>
                    <label className='even-odd-ai__toggle'>
                        <span><strong>Recovery mode</strong><small>Three recovery layers · 1.5 multiplier</small></span>
                        <input type='checkbox' checked={recoveryEnabled} onChange={event => setRecoveryEnabled(event.target.checked)} />
                    </label>
                    <div className='even-odd-ai__locked'><span>EXECUTION LOCKED</span><strong>Analysis-only mode</strong><small>No proposals, purchases or account transactions are sent by this dashboard yet.</small></div>
                </aside>
            </section>

            <section className='even-odd-ai__tools'>
                <div><span className='even-odd-ai__eyebrow'>ENGINE STATUS</span><h3>Analysis pipeline</h3></div>
                <div className='even-odd-ai__tool-grid'>
                    {['Live tick listener','Tick data validation','Quote precision processor','Last-digit extractor','Even/Odd classifier','Historical tick analyser','Digit frequency analyser','Pattern recognition','Market stability filter','Volatility market ranking','AI market selector','Prediction evidence scoring','Entry confirmation screen','Contract validation · locked','Risk controller · configured','Recovery manager · inactive','Trade execution · locked','Performance journal'].map((tool, index) => (
                        <div key={tool}><span>{String(index + 1).padStart(2, '0')}</span>{tool}<i className={index < 13 && isScanning ? 'is-active' : ''} /></div>
                    ))}
                </div>
            </section>
            <footer className='even-odd-ai__footer'>A distribution gap is descriptive evidence from recent ticks, not a prediction guarantee or probability of winning. This module does not place trades.</footer>
        </main>
    );
});

export default EvenOddAiDashboard;
