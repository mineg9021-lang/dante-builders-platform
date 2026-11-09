import React, { useEffect, useMemo, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import './even-odd-terminal.scss';

type TickMessage = {
    msg_type?: string;
    tick?: { symbol?: string; quote?: number | string; epoch?: number };
    error?: { message?: string };
};

type TickRecord = { digit: number; quote: string; epoch: number };
type SymbolState = { symbol: string; name: string; pipSize: number; ticks: TickRecord[]; status: string };

const MAX_TICKS = 120;
const MAX_AGE_MS = 15000;

const getPrecision = (pipSize?: number) => {
    if (!pipSize || !Number.isFinite(pipSize)) return 2;
    const value = String(pipSize);
    return value.includes('.') ? value.split('.')[1].length : 0;
};

const getLastDigit = (quote: number | string, precision: number) => {
    const fixed = typeof quote === 'number' ? quote.toFixed(precision) : String(quote);
    const digits = fixed.replace(/[^0-9]/g, '');
    return digits.length ? Number(digits[digits.length - 1]) : null;
};

const EvenOddTerminal = () => {
    const { isAuthorized, connectionStatus } = useApiBase();
    const [symbols, setSymbols] = useState<SymbolState[]>([]);
    const [selectedSymbol, setSelectedSymbol] = useState('');
    const [stake, setStake] = useState('1');
    const [stopLoss, setStopLoss] = useState('10');
    const [takeProfit, setTakeProfit] = useState('10');
    const [recoveryEnabled, setRecoveryEnabled] = useState(false);
    const [running, setRunning] = useState(true);
    const [notice, setNotice] = useState('Connect your Deriv account to start live market analysis.');
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    const availableSymbols = useMemo(() => {
        const active = Array.isArray(api_base.active_symbols) ? api_base.active_symbols : [];
        return active.filter((item: any) => {
            const name = String(item.display_name || item.symbol_display_name || '');
            const symbol = String(item.symbol || '');
            return symbol.startsWith('R_') || /volatility .* index/i.test(name);
        });
    }, [connectionStatus, isAuthorized, lastUpdated]);

    useEffect(() => {
        if (!running || !isAuthorized || connectionStatus !== 'opened' || !api_base.api) {
            setRunning(false);
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
            pipSize: Number(item.pip_size || item.pip) || 2,
            ticks: [],
            status: 'Connecting',
        }));
        setSymbols(initial);
        if (!selectedSymbol && initial.length) setSelectedSymbol(initial[0].symbol);

        let mounted = true;
        const subscriptions: Array<{ unsubscribe: () => void }> = [];
        const messageSubscription = api_base.api.onMessage().subscribe((raw: unknown) => {
            const message = raw as TickMessage;
            if (!mounted || message.msg_type !== 'tick' || !message.tick?.symbol) return;
            const quote = message.tick.quote;
            if (quote === undefined || quote === null) return;
            setSymbols(previous => previous.map(item => {
                if (item.symbol !== message.tick?.symbol) return item;
                const precision = getPrecision(item.pipSize);
                const fixed = typeof quote === 'number' ? quote.toFixed(precision) : String(quote);
                const digit = getLastDigit(quote, precision);
                if (digit === null) return item;
                const epoch = Number(message.tick?.epoch || 0);
                const last = item.ticks[item.ticks.length - 1];
                if (last && (epoch <= last.epoch || fixed === last.quote)) return item;
                return {
                    ...item,
                    status: 'Live',
                    ticks: [...item.ticks, { digit, quote: fixed, epoch }].slice(-MAX_TICKS),
                };
            }));
            setLastUpdated(Date.now());
        });
        const connect = async () => {
            for (const item of initial) {
                try {
                    const pending = api_base.api?.send({ ticks: item.symbol, subscribe: 1 }) as any;
                    if (pending?.then) {
                        const result = await pending;
                        if (result?.subscription) subscriptions.push(result.subscription);
                    }
                    if (!mounted) break;
                } catch (error) {
                    setSymbols(previous => previous.map(row => row.symbol === item.symbol
                        ? { ...row, status: 'Unavailable' } : row));
                }
            }
        };
        setNotice('Live tick analysis is active. Trading is disabled in this module.');
        connect();

        return () => {
            mounted = false;
            messageSubscription.unsubscribe();
            subscriptions.forEach(subscription => subscription.unsubscribe());
        };
    }, [running, isAuthorized, connectionStatus, availableSymbols.length]);

    const selected = symbols.find(item => item.symbol === selectedSymbol);
    const counts = selected?.ticks.reduce((acc, tick) => {
        acc[tick.digit % 2 === 0 ? 'even' : 'odd'] += 1;
        return acc;
    }, { even: 0, odd: 0 }) || { even: 0, odd: 0 };
    const total = counts.even + counts.odd;
    const prediction = total >= 20 && Math.abs(counts.even - counts.odd) >= 4
        ? (counts.even > counts.odd ? 'EVEN' : 'ODD')
        : 'WAIT';
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
                        <div className='eo-terminal__card-heading'><h3>Market scanner</h3><span>{symbols.length} eligible markets</span></div>
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
                            <div><span>Analysis sample</span><strong>{total}/120</strong></div>
                        </div>
                        <div className='eo-terminal__signal'>
                            <span>Parity assessment</span>
                            <strong className={prediction === 'WAIT' ? 'is-wait' : 'is-signal'}>{prediction}</strong>
                            <small>{prediction === 'WAIT' ? 'Insufficient evidence for a candidate.' : 'Historical frequency candidate only — not a trade instruction.'}</small>
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
                </div>

                <aside className='eo-terminal__side'>
                    <div className='eo-terminal__card'>
                        <h3>Risk configuration</h3>
                        <label>Stake amount<input type='number' min='0.35' step='0.01' value={stake} onChange={event => setStake(event.target.value)} /></label>
                        <label>Stop-loss<input type='number' min='0' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} /></label>
                        <label>Take-profit<input type='number' min='0' step='0.01' value={takeProfit} onChange={event => setTakeProfit(event.target.value)} /></label>
                        <label className='eo-terminal__toggle'><input type='checkbox' checked={recoveryEnabled} onChange={event => setRecoveryEnabled(event.target.checked)} /> Enable capped recovery (off by default)</label>
                        <p className='eo-terminal__disclaimer'>These settings are saved in this screen only. No orders are placed and no recovery progression is executed.</p>
                        <button type='button' disabled>Start trading — not enabled</button>
                        <button type='button' className='eo-terminal__stop' onClick={() => setRunning(false)}>Stop analysis</button>
                    </div>
                    <div className='eo-terminal__card eo-terminal__portrait'>
                        <div className='eo-terminal__robot' aria-hidden='true'>AI</div>
                        <div><strong>Analysis engine</strong><span>18-stage architecture planned</span></div>
                    </div>
                </aside>
            </div>
            <footer className='eo-terminal__notice'>{notice} <strong>Analysis-only mode · no trades will be placed.</strong></footer>
        </section>
    );
};

export default EvenOddTerminal;
