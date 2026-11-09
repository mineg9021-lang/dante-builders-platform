import React, { useEffect, useMemo, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { validateTick } from './even-odd-analysis-engine';
import { runParityPipeline } from './even-odd-parity-engine';
import './even-odd-terminal.scss';

type TickMessage = {
    msg_type?: string;
    tick?: { symbol?: string; quote?: number | string; epoch?: number };
    error?: { message?: string };
};

type TickRecord = { digit: number; quote: string; epoch: number };
type SymbolState = { symbol: string; name: string; precision: number; ticks: TickRecord[]; status: string };

const MAX_TICKS = 30;
const MAX_ANALYSIS_DURATION_MS = 60_000;

const getPrecision = (pipSize?: number) => {
    if (pipSize === undefined || !Number.isFinite(pipSize) || pipSize <= 0) return 2;
    const value = String(pipSize).toLowerCase();
    if (value.includes('e')) {
        const [coefficient, exponentText] = value.split('e');
        const fractionalPlaces = coefficient.split('.')[1]?.length || 0;
        return Math.max(0, Math.min(10, fractionalPlaces - Number(exponentText)));
    }
    return Math.min(10, value.split('.')[1]?.length || 0);
};

const EvenOddTerminal = () => {
    const { isAuthorized, connectionStatus, authData } = useApiBase();
    const [symbols, setSymbols] = useState<SymbolState[]>([]);
    const [selectedSymbol, setSelectedSymbol] = useState('');
    const [stake, setStake] = useState('1');
    const [stopLoss, setStopLoss] = useState('10');
    const [takeProfit, setTakeProfit] = useState('10');
    const [running, setRunning] = useState(false);
    const [notice, setNotice] = useState('Connect your Deriv account to start live market analysis.');
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    useEffect(() => {
        if (!isAuthorized || connectionStatus !== 'opened') return;
        const timer = window.setInterval(() => {
            if (Array.isArray(api_base.active_symbols) && api_base.active_symbols.length) {
                // Refresh the derived market list while the existing APIBase loads/enriches symbols.
                setLastUpdated(Date.now());
            }
        }, 750);
        return () => window.clearInterval(timer);
    }, [isAuthorized, connectionStatus]);

    const availableSymbols = useMemo(() => {
        const active = Array.isArray(api_base.active_symbols) ? api_base.active_symbols : [];
        return active.filter((item: any) => {
            const name = String(item.display_name || item.symbol_display_name || '');
            const symbol = String(item.symbol || '');
            return /volatility/i.test(name) && Boolean(symbol);
        });
    }, [connectionStatus, isAuthorized, lastUpdated]);

    const availableSymbolKey = availableSymbols.map((item: any) => item.symbol).join('|');

    useEffect(() => {
        if (!running) return;
        if (!isAuthorized || connectionStatus !== 'opened' || !api_base.api) {
            setNotice('Waiting for an authorized Deriv connection.');
            return;
        }
        if (!availableSymbols.length) {
            setNotice('Waiting for Deriv active-symbol data.');
            return;
        }

        const initial: SymbolState[] = availableSymbols.map((item: any) => ({
            symbol: item.symbol,
            name: item.display_name || item.symbol_display_name || item.symbol,
            precision: Number(api_base.pip_sizes[item.underlying_symbol || item.symbol] ?? getPrecision(Number(item.pip_size || item.pip)) ?? 2),
            ticks: [],
            status: 'Connecting',
        }));
        setSymbols(initial);
        if (!selectedSymbol && initial.length) setSelectedSymbol(initial[0].symbol);

        let mounted = true;
        const subscriptions: Array<{ id?: string; unsubscribe?: () => void }> = [];
        const forgetSubscription = (subscription: { id?: string; unsubscribe?: () => void }) => {
            if (subscription.id) {
                // Match APIBase's established Deriv subscription cleanup contract.
                api_base.api?.send({ forget: subscription.id });
            } else {
                subscription.unsubscribe?.();
            }
        };
        const messageSubscription = api_base.api.onMessage().subscribe((raw: unknown) => {
            const message = raw as TickMessage;
            if (!mounted || message.msg_type !== 'tick' || !message.tick?.symbol) return;
            const quote = message.tick.quote;
            if (quote === undefined || quote === null) return;
            setSymbols(previous => previous.map(item => {
                if (item.symbol !== message.tick?.symbol) return item;
                const epoch = Number(message.tick?.epoch || 0);
                if (item.ticks.length >= MAX_TICKS) return item;
                const last = item.ticks[item.ticks.length - 1];
                const validation = validateTick(
                    item.symbol,
                    quote,
                    epoch,
                    item.precision,
                    last?.epoch
                );
                if (!validation.accepted || !validation.tick) return item;
                const { digit, quote: fixed, epoch: validEpoch } = validation.tick;
                const ticks = [...item.ticks, { digit, quote: fixed, epoch: validEpoch }];
                return {
                    ...item,
                    status: ticks.length >= MAX_TICKS ? 'Sample complete' : 'Live',
                    ticks,
                };
            }));
        });
        const connect = async () => {
            // Start all market subscriptions together so one slow symbol cannot block the scanner.
            await Promise.all(initial.map(async item => {
                try {
                    const pending = api_base.api?.send({ ticks: item.symbol, subscribe: 1 }) as any;
                    if (pending?.then) {
                        const result = await pending;
                        if (result?.subscription) {
                            if (mounted) subscriptions.push(result.subscription);
                            else forgetSubscription(result.subscription);
                        }
                    }
                } catch (error) {
                    if (!mounted) return;
                    setSymbols(previous => previous.map(row => row.symbol === item.symbol
                        ? { ...row, status: 'Unavailable' } : row));
                }
            }));
        };
        setNotice(`Bounded scan active: up to ${MAX_TICKS} valid ticks per market, with a ${MAX_ANALYSIS_DURATION_MS / 1000}-second time limit. Trading is disabled.`);
        connect();
        const timeout = window.setTimeout(() => {
            if (mounted) {
                setNotice('Analysis time limit reached. The bounded scan has stopped.');
                setRunning(false);
            }
        }, MAX_ANALYSIS_DURATION_MS);

        return () => {
            window.clearTimeout(timeout);
            mounted = false;
            messageSubscription.unsubscribe();
            subscriptions.forEach(forgetSubscription);
        };
    }, [running, isAuthorized, connectionStatus, availableSymbolKey]);

    useEffect(() => {
        if (running && symbols.length > 0 && symbols.every(item => item.ticks.length >= MAX_TICKS)) {
            setNotice('All detected markets completed their 30-tick samples. The bounded scan has stopped.');
            setRunning(false);
        }
    }, [running, symbols]);

    const selected = symbols.find(item => item.symbol === selectedSymbol);
    const pipeline = runParityPipeline({
        symbol: selected?.symbol || '',
        ticks: (selected?.ticks || []).map(tick => ({
            symbol: selected?.symbol || '',
            quote: tick.quote,
            epoch: tick.epoch,
            digit: tick.digit,
            parity: tick.digit % 2 === 0 ? 'EVEN' as const : 'ODD' as const,
        })),
        config: {
            mode: 'analysis',
            armed: false,
            authorized: isAuthorized,
            demoAccount: Boolean(authData?.is_virtual),
            maxTicks: MAX_TICKS,
            minSample: 30,
            minLead: 0.12,
            minStableRatio: 1,
            stake: Number(stake),
            availableBalance: Number(authData?.balance || 0),
            maxStakePercent: 2,
            sessionLoss: 0,
            stopLoss: Number(stopLoss),
            takeProfit: Number(takeProfit),
        },
    });
    const counts = { even: pipeline.evenCount, odd: pipeline.oddCount };
    const total = pipeline.sampleSize;
    const prediction = pipeline.selectedParity === 'NONE' ? 'WAIT' : `${pipeline.selectedParity} LEADING`;
    const latest = selected?.ticks[selected.ticks.length - 1];

    return (
        <section className='eo-terminal'>
            <header className='eo-terminal__header'>
                <div>
                    <span className='eo-terminal__eyebrow'>DANTE BUILDERS · MARKET INTELLIGENCE</span>
                    <h2>AI Even / Odd Terminal</h2>
                    <p>Live tick observation, parity statistics and disciplined entry screening.</p>
                </div>
                <div className={`eo-terminal__connection ${isAuthorized && connectionStatus === 'opened' ? 'is-live' : ''}`}>
                    <span /> {isAuthorized && connectionStatus === 'opened' ? 'DERIV CONNECTED' : 'NOT CONNECTED'}
                </div>
            </header>

            <div className='eo-terminal__grid'>
                <div className='eo-terminal__main'>
                    <div className='eo-terminal__card eo-terminal__market'>
                        <div className='eo-terminal__card-heading'><h3>Market scanner</h3><span>{availableSymbols.length} eligible markets detected</span></div>
                        <div className='eo-terminal__market-row'>
                            <label htmlFor='eo-symbol'>Selected volatility index</label>
                            <select id='eo-symbol' value={selectedSymbol} onChange={event => setSelectedSymbol(event.target.value)}>
                                {symbols.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}
                            </select>
                        </div>
                        <div className='eo-terminal__stats'>
                            <div><span>Latest digit</span><strong>{latest ? latest.digit : '—'}</strong></div>
                            <div><span>Even observations</span><strong>{counts.even}</strong></div>
                            <div><span>Odd observations</span><strong>{counts.odd}</strong></div>
                            <div><span>Analysis sample</span><strong>{total}/30</strong></div>
                        </div>
                        <div className='eo-terminal__signal'>
                            <span>Observed parity lead · evidence {pipeline.evidenceScore}%</span>
                            <strong className={prediction === 'WAIT' ? 'is-wait' : 'is-signal'}>{prediction}</strong>
                            <small>{prediction === 'WAIT' ? 'Insufficient sample or parity difference. No entry candidate.' : `Observed sample lead only · evidence difference ${analysis.evidenceScore}% · not a next-tick forecast.`}</small>
                        </div>
                    </div>
                    <div className='eo-terminal__card'>
                        <div className='eo-terminal__card-heading'><h3>Market feed</h3><span>Recent valid ticks</span></div>
                        <div className='eo-terminal__feed'>
                            {(selected?.ticks.slice(-12).reverse() || []).map((tick, index) => (
                                <div key={`${tick.epoch}-${index}`}><span>{tick.quote}</span><b className={tick.digit % 2 === 0 ? 'is-even' : 'is-odd'}>{tick.digit % 2 === 0 ? 'EVEN' : 'ODD'}</b></div>
                            ))}
                            {!selected?.ticks.length && <p>Waiting for live ticks from Deriv…</p>}
                        </div>
                    </div>
                    <div className='eo-terminal__card eo-terminal__layers'>
                        <div className='eo-terminal__card-heading'><h3>18 engine layers</h3><span>Live pipeline status</span></div>
                        <div className='eo-terminal__layer-list'>
                            {pipeline.stages.map(item => (
                                <div className={`eo-terminal__layer eo-terminal__layer--${item.status.toLowerCase()}`} key={item.id}>
                                    <b>{String(item.id).padStart(2, '0')}</b>
                                    <div><strong>{item.name}</strong><small>{item.detail}</small></div>
                                    <em>{item.status}</em>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <aside className='eo-terminal__side'>
                    <div className='eo-terminal__card'>
                        <h3>Risk configuration</h3>
                        <label>Stake amount<input type='number' min='0.35' step='0.01' value={stake} onChange={event => setStake(event.target.value)} /></label>
                        <label>Stop-loss<input type='number' min='0' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} /></label>
                        <label>Take-profit<input type='number' min='0' step='0.01' value={takeProfit} onChange={event => setTakeProfit(event.target.value)} /></label>
                        
                        <p className='eo-terminal__disclaimer'>Stake and limits feed the risk-control layer. No orders are placed in this analysis build; recovery and martingale are not used.</p>
                        <button type='button' onClick={() => { setNotice('Starting bounded market analysis…'); setRunning(true); }} disabled={running}>Start analysis</button>
                        <button type='button' className='eo-terminal__stop' onClick={() => { setNotice('Analysis stopped manually.'); setRunning(false); }} disabled={!running}>Stop analysis</button>
                    </div>
                    <div className='eo-terminal__card eo-terminal__portrait'>
                        <div className='eo-terminal__robot' aria-hidden='true'>
                            <svg viewBox='0 0 96 96' role='img'>
                                <defs>
                                    <linearGradient id='eo-android-metal' x1='0' y1='0' x2='1' y2='1'>
                                        <stop offset='0%' stopColor='#f9fffb' />
                                        <stop offset='55%' stopColor='#c6e8d2' />
                                        <stop offset='100%' stopColor='#4d9b6c' />
                                    </linearGradient>
                                    <linearGradient id='eo-android-glow' x1='0' y1='0' x2='1' y2='1'>
                                        <stop offset='0%' stopColor='#1b9b58' />
                                        <stop offset='100%' stopColor='#063d28' />
                                    </linearGradient>
                                </defs>
                                <path d='M48 5 69 13 82 31 86 55 73 80 48 92 23 80 10 55 14 31 27 13Z' fill='url(#eo-android-metal)' stroke='#247a4b' strokeWidth='2'/>
                                <path d='M29 26Q48 13 67 26L72 52Q68 72 48 78Q28 72 24 52Z' fill='#f7fff9' stroke='#287c4d' strokeWidth='2'/>
                                <path d='M25 34 16 26 21 48 27 49M71 34 80 26 75 48 69 49' fill='url(#eo-android-glow)' stroke='#145c38' strokeWidth='2'/>
                                <path d='M31 43Q39 37 44 43M52 43Q59 37 65 43' fill='none' stroke='#17683f' strokeWidth='3' strokeLinecap='round'/>
                                <ellipse cx='38' cy='48' rx='4' ry='3' fill='#16834a'/><ellipse cx='59' cy='48' rx='4' ry='3' fill='#16834a'/>
                                <path d='M48 48 45 57 51 57M39 65Q48 70 57 65' fill='none' stroke='#397e56' strokeWidth='2' strokeLinecap='round'/>
                                <path d='M36 9 48 3 60 9 56 20 40 20Z' fill='url(#eo-android-glow)' stroke='#247a4b' strokeWidth='2'/>
                                <path d='M44 4 48 0 52 4' fill='none' stroke='#baf2cf' strokeWidth='2'/>
                            </svg>
                        </div>
                        <div><strong>Parity intelligence</strong><span>18 connected analysis and safety layers</span></div>
                    </div>
                </aside>
            </div>
            <footer className='eo-terminal__notice'>{notice} <strong>Analysis-only mode · no trades will be placed.</strong></footer>
        </section>
    );
};

export default EvenOddTerminal;
