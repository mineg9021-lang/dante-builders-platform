import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { extractLastDigit, quoteWithPrecision } from './digit-matches-engine';
import { runOverTwoPipeline, type OverTwoTick } from './over-two-engine';
import { executeOverTwoContract, type OverTwoApi } from './over-two-execution';
import './over-two-terminal.scss';

const BOT_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V'];
const MAX_TICKS = 60;
type MarketSample = { symbol: string; name: string; precision: number; ticks: OverTwoTick[]; status: string };
type TradeRow = { id: string; contractId?: number; symbol: string; status: 'EXECUTED' | 'WON' | 'LOST' | 'VOID'; profit?: number; time: number };

const precisionFromPip = (pip?: number) => {
    if (!pip || !Number.isFinite(pip)) return 2;
    const value = String(pip).toLowerCase();
    if (value.includes('e')) {
        const parts = value.split('e');
        return Math.max(0, Math.min(10, (parts[0].split('.')[1] || '').length - Number(parts[1])));
    }
    return Math.min(10, (value.split('.')[1] || '').length);
};

const OverTwoTerminal = () => {
    const { isAuthorized, connectionStatus, authData } = useApiBase();
    const [markets, setMarkets] = useState<MarketSample[]>([]);
    const [lastUpdated, setLastUpdated] = useState(0);
    const [stake, setStake] = useState('1');
    const [stopLoss, setStopLoss] = useState('10');
    const [takeProfit, setTakeProfit] = useState('10');
    const [martingaleEnabled, setMartingaleEnabled] = useState(false);
    const [lossStep, setLossStep] = useState(0);
    const [recoveryLevel, setRecoveryLevel] = useState(0);
    const [cooldown, setCooldown] = useState(false);
    const [mode, setMode] = useState<'analysis' | 'demo' | 'live'>('analysis');
    const [running, setRunning] = useState(false);
    const [executionArmed, setExecutionArmed] = useState(false);
    const [status, setStatus] = useState('STOPPED');
    const [notice, setNotice] = useState('Connect Deriv to begin the hidden 13-market scan.');
    const [sessionPnl, setSessionPnl] = useState(0);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [trades, setTrades] = useState<TradeRow[]>([]);
    const [executionStatus, setExecutionStatus] = useState('No order submitted');
    const executionLock = useRef(false);
    const executionAllowed = useRef(false);
    const consumedSample = useRef('');
    const accountId = authData?.loginid || '';
    const balance = Number(authData?.balance || 0);
    const currency = authData?.currency || '';
    const effectiveStake = Number((Number(stake) * Math.pow(1.5, martingaleEnabled ? lossStep : 0)).toFixed(2));

    useEffect(() => {
        if (authData?.is_virtual && mode === 'analysis') setMode('demo');
    }, [authData?.loginid, authData?.is_virtual, mode]);

    useEffect(() => {
        if (!isAuthorized || connectionStatus !== 'opened') return;
        const timer = window.setInterval(() => {
            if (Array.isArray(api_base.active_symbols) && api_base.active_symbols.length) setLastUpdated(Date.now());
        }, 1000);
        return () => window.clearInterval(timer);
    }, [isAuthorized, connectionStatus]);

    const availableSymbols = useMemo(() => {
        const active = Array.isArray(api_base.active_symbols) ? api_base.active_symbols : [];
        return active.filter((item: any) => {
            const symbol = String(item.symbol || item.underlying_symbol || '');
            return BOT_SYMBOLS.includes(symbol);
        }).map((item: any) => ({
            symbol: String(item.symbol || item.underlying_symbol),
            name: String(item.display_name || item.symbol_display_name || item.underlying_symbol_name || item.symbol || item.underlying_symbol),
            precision: Number(api_base.pip_sizes?.[item.symbol || item.underlying_symbol] ?? precisionFromPip(Number(item.pip_size || item.pip))),
        }));
    }, [connectionStatus, isAuthorized, lastUpdated]);

    const availableKey = availableSymbols.map(item => item.symbol).sort().join('|');

    useEffect(() => {
        if (!running) return;
        if (!isAuthorized || connectionStatus !== 'opened' || !api_base.api) {
            setStatus('WAITING FOR DERIV');
            setNotice('Open an authorised Deriv connection before starting the Over 2 bot.');
            return;
        }
        if (!availableSymbols.length) {
            setStatus('WAITING FOR MARKETS');
            setNotice('Deriv has not returned any of the configured Volatility markets yet.');
            return;
        }

        let mounted = true;
        const subscriptions: Array<{ id?: string; unsubscribe?: () => void }> = [];
        const initial: MarketSample[] = availableSymbols.map(item => ({ ...item, ticks: [], status: 'CONNECTING' }));
        setMarkets(initial);
        const stream = api_base.api.onMessage().subscribe((raw: unknown) => {
            const message = raw as any;
            if (!mounted || message?.msg_type !== 'tick' || !message.tick?.symbol) return;
            const symbol = String(message.tick.symbol);
            const quoteValue = message.tick.quote;
            const epoch = Number(message.tick.epoch);
            if (quoteValue === undefined || !Number.isFinite(epoch)) return;
            setMarkets(previous => previous.map(market => {
                if (market.symbol !== symbol || market.ticks.length >= MAX_TICKS) return market;
                const last = market.ticks[market.ticks.length - 1];
                if (last && epoch <= last.epoch) return market;
                try {
                    const quote = quoteWithPrecision(quoteValue, market.precision);
                    const digit = extractLastDigit(quote);
                    const ticks = [...market.ticks, { symbol, quote, epoch, digit }];
                    return { ...market, ticks, status: ticks.length >= MAX_TICKS ? 'SAMPLE COMPLETE' : 'LIVE' };
                } catch {
                    return market;
                }
            }));
        });

        const subscribe = async () => {
            await Promise.all(initial.map(async market => {
                try {
                    const response = await api_base.api?.send({ ticks: market.symbol, subscribe: 1 }) as any;
                    const subscription = response?.subscription;
                    if (!mounted && subscription?.id) {
                        void api_base.api?.send({ forget: subscription.id });
                    } else if (subscription) {
                        subscriptions.push(subscription);
                    }
                    if (response?.error) throw new Error(response.error.message || 'Tick subscription failed');
                } catch {
                    if (mounted) setMarkets(previous => previous.map(item => item.symbol === market.symbol ? { ...item, status: 'UNAVAILABLE' } : item));
                }
            }));
        };
        setStatus('SCANNING 13-MARKET UNIVERSE');
        setNotice('Collecting real Deriv ticks across the supported Volatility markets. The first qualifying market is ranked; no order is sent without all 18 gates.');
        void subscribe();
        const timeout = window.setTimeout(() => {
            if (mounted) {
                executionAllowed.current = false;
                setExecutionArmed(false);
                setRunning(false);
                setStatus('SCAN TIME LIMIT');
                setExecutionStatus('WAIT · scan timed out; no order was placed');
                setNotice('The bounded scan reached its time limit. Start a fresh scan; no trade was forced.');
            }
        }, 180000);
        return () => {
            mounted = false;
            window.clearTimeout(timeout);
            stream.unsubscribe();
            subscriptions.forEach(sub => {
                if (sub.id) void api_base.api?.send({ forget: sub.id });
                else sub.unsubscribe?.();
            });
        };
    }, [running, isAuthorized, connectionStatus, availableKey]);

    const config = useMemo(() => ({
        mode, armed: executionArmed, authorized: isAuthorized && connectionStatus === 'opened',
        demoAccount: Boolean(authData?.is_virtual), stake: effectiveStake, balance,
        stopLoss: Number(stopLoss), takeProfit: Number(takeProfit),
        sessionLoss: Math.max(0, -sessionPnl), sessionProfit: Math.max(0, sessionPnl),
        tradesThisSession: trades.length, maxTradesPerSession: 10,
        minSample: 30, maxTicks: MAX_TICKS, minOverRate: 0.70, minHalfRate: 0.60,
    }), [mode, executionArmed, isAuthorized, connectionStatus, authData?.is_virtual, effectiveStake, balance, stopLoss, takeProfit, sessionPnl, trades.length]);

    const ranked = useMemo(() => markets.map(market => ({
        market,
        result: runOverTwoPipeline({ symbol: market.symbol, ticks: market.ticks, config }),
    })).sort((a, b) => {
        if (a.result.executionAuthorized !== b.result.executionAuthorized) return a.result.executionAuthorized ? -1 : 1;
        if (a.result.evidenceScore !== b.result.evidenceScore) return b.result.evidenceScore - a.result.evidenceScore;
        return b.result.sampleSize - a.result.sampleSize;
    }), [markets, config]);
    const best = ranked[0];
    const ready = ranked.find(item => item.result.executionAuthorized);
    const current = ready || best;
    const latest = current?.market.ticks[current.market.ticks.length - 1];
    const winRate = wins + losses ? Math.round((wins / (wins + losses)) * 100) : 0;

    useEffect(() => {
        if (!executionArmed || !current?.result.executionAuthorized || !latest || executionLock.current || !api_base.api || !currency) return;
        const sampleKey = current.market.symbol + ':' + latest.epoch + ':' + current.result.evidenceScore;
        if (consumedSample.current === sampleKey) return;
        consumedSample.current = sampleKey;
        executionLock.current = true;
        setExecutionStatus('Checking DIGITOVER availability and requesting a Deriv proposal…');
        executeOverTwoContract({
            api: api_base.api as unknown as OverTwoApi,
            symbol: current.market.symbol,
            stake: effectiveStake,
            currency,
            mode,
            executionPermission: current.result.executionAuthorized,
            authorized: isAuthorized && connectionStatus === 'opened',
            isVirtual: Boolean(authData?.is_virtual),
            lastTickEpoch: latest.epoch,
            shouldContinue: () => executionAllowed.current,
            onPurchased: purchase => {
                setTrades(previous => [{ id: String(purchase.contractId), contractId: purchase.contractId, symbol: purchase.symbol, status: 'EXECUTED', time: purchase.createdAt }, ...previous].slice(0, 30));
                setExecutionStatus('PURCHASE ACCEPTED · monitoring contract #' + purchase.contractId);
            },
        }).then(result => {
            setSessionPnl(previous => previous + result.profit);
            if (result.settlement === 'WON') setWins(previous => previous + 1);
            if (result.settlement === 'LOST') setLosses(previous => previous + 1);
            setTrades(previous => previous.map(row => row.contractId === result.contractId ? { ...row, status: result.settlement, profit: result.profit } : row));
            setExecutionStatus(result.settlement + ' · ' + result.profit.toFixed(2) + ' ' + currency);
            const nextPnl = sessionPnl + result.profit;
            const sessionLimitReached = nextPnl <= -Number(stopLoss) || nextPnl >= Number(takeProfit) || trades.length + 1 >= 10;
            if (result.settlement === 'WON') {
                setLossStep(0);
                setRecoveryLevel(0);
                executionAllowed.current = false;
                setExecutionArmed(false);
                setRunning(false);
                setStatus(sessionLimitReached ? 'SESSION LIMIT · PAUSED' : 'TRADE WON · STOPPED');
                setNotice(sessionLimitReached ? 'A configured session limit was reached. Review the session before restarting.' : 'Winning contract settled and recorded. Start a fresh scan when ready.');
            } else if (result.settlement === 'LOST') {
                const martingaleLimitReached = martingaleEnabled && lossStep >= 3;
                const recoveryLimitReached = recoveryLevel >= 3;
                if (martingaleEnabled && !martingaleLimitReached) setLossStep(previous => previous + 1);
                if (!recoveryLimitReached) setRecoveryLevel(previous => previous + 1);
                if (sessionLimitReached || martingaleLimitReached || recoveryLimitReached) {
                    executionAllowed.current = false;
                    setExecutionArmed(false);
                    setRunning(false);
                    if (recoveryLimitReached) {
                        setCooldown(true);
                        setStatus('COOLDOWN · 4TH LOSS');
                        setExecutionStatus('Fourth consecutive recovery loss reached. Bot paused for cooldown; manual review required.');
                    } else if (martingaleLimitReached) {
                        setStatus('MARTINGALE LIMIT · PAUSED');
                        setExecutionStatus('Maximum configured 1.5× progression reached. No further recovery trade will be placed.');
                    } else {
                        setStatus('SESSION LIMIT · PAUSED');
                    }
                    setNotice('Recovery stopped because a session or configured safety limit was reached.');
                } else {
                    executionAllowed.current = true;
                    setExecutionArmed(false);
                    setRunning(false);
                    setStatus('RECOVERY ' + (recoveryLevel + 1) + ' · PREPARING');
                    setExecutionStatus('LOSS · preparing a fresh bounded recovery scan');
                    setNotice('Loss recorded. The next recovery stage will collect a new market sample; it will not reuse the previous entry.');
                    window.setTimeout(() => {
                        if (!executionAllowed.current) return;
                        setMarkets([]);
                        setExecutionArmed(true);
                        setRunning(true);
                        setStatus('RECOVERY ' + (recoveryLevel + 1) + ' · SCANNING');
                    }, 650);
                }
            } else {
                executionAllowed.current = false;
                setExecutionArmed(false);
                setRunning(false);
                setStatus('CONTRACT VOID · STOPPED');
                setNotice('The contract was voided. No recovery progression was applied.');
            }
        }).catch(error => {
            executionAllowed.current = false;
            setExecutionArmed(false);
            setRunning(false);
            setStatus('EXECUTION BLOCKED');
            setExecutionStatus('BLOCKED · ' + (error instanceof Error ? error.message : 'Deriv execution failed'));
        }).finally(() => {
            executionLock.current = false;
        });
    }, [executionArmed, current?.market.symbol, current?.result.executionAuthorized, latest?.epoch, effectiveStake, currency, mode, isAuthorized, connectionStatus, authData?.is_virtual, martingaleEnabled, lossStep, recoveryLevel, sessionPnl, stopLoss, takeProfit, trades.length]);

    useEffect(() => {
        if (!running || executionArmed || !markets.length) return;
        if (markets.every(market => market.ticks.length >= MAX_TICKS || market.status === 'UNAVAILABLE')) {
            setRunning(false);
            setStatus('ANALYSIS COMPLETE');
            setNotice('All available market samples are complete. No purchase was attempted in analysis mode.');
        }
    }, [running, executionArmed, markets]);

    const start = () => {
        if (!isAuthorized || connectionStatus !== 'opened') {
            setNotice('Connect Deriv first. Your account must be authorised and the WebSocket connected.');
            return;
        }
        if (!Number.isFinite(Number(stake)) || Number(stake) <= 0 || Number(stopLoss) <= 0 || Number(takeProfit) <= 0) {
            setNotice('Enter a positive stake, stop-loss and take-profit before starting.');
            return;
        }
        if (mode === 'demo' && !authData?.is_virtual) {
            setNotice('Switch to a Deriv virtual account before selecting Demo mode.');
            return;
        }
        if (mode === 'live' && authData?.is_virtual) {
            setNotice('Switch to a Deriv real account before selecting Live mode.');
            return;
        }
        if (mode === 'live' && !window.confirm('Live mode can place real-money trades. Continue only if you accept the risk?')) return;
        if (cooldown) {
            setNotice('Cooldown is active after the fourth recovery loss. Reset the session after manual review.');
            return;
        }
        executionAllowed.current = mode !== 'analysis';
        setExecutionArmed(mode !== 'analysis');
        setMarkets([]);
        consumedSample.current = '';
        setRunning(true);
        setStatus(mode === 'analysis' ? 'ANALYSIS SCAN' : mode.toUpperCase() + ' · ARMED');
        setExecutionStatus(mode === 'analysis' ? 'Analysis only · purchases disabled' : 'Armed · waiting for all 18 gates');
    };

    const stop = () => {
        executionAllowed.current = false;
        setExecutionArmed(false);
        setRunning(false);
        setStatus('STOPPED BY USER');
        setNotice(executionLock.current ? 'Bot disarmed. Any already accepted contract will still be monitored to settlement.' : 'Bot stopped. No further purchases will be submitted.');
    };

    const changeMode = (next: 'analysis' | 'demo' | 'live') => {
        executionAllowed.current = false;
        setExecutionArmed(false);
        setRunning(false);
        setMode(next);
        setStatus(next.toUpperCase() + ' · DISARMED');
    };

    const resetCooldown = () => {
        setCooldown(false);
        setRecoveryLevel(0);
        setLossStep(0);
        setSessionPnl(0);
        setWins(0);
        setLosses(0);
        setTrades([]);
        setStatus('SESSION RESET');
        setNotice('Recovery and cooldown counters reset. Review the account before starting a new session.');
    };

    return (
        <section className='over2-terminal'>
            <header className='over2-header'>
                <div className='over2-portrait over2-portrait--over'><span>O2</span></div>
                <div className='over2-heading'>
                    <span className='over2-eyebrow'>DANTE BUILDERS · 18-LAYER STRATEGY</span>
                    <h2>Over 2 Specialist Bot</h2>
                    <p>Analyses live final digits and only considers DIGITOVER with barrier 2. No market is displayed as a forecast guarantee.</p>
                </div>
                <div className={'over2-connection ' + (isAuthorized && connectionStatus === 'opened' ? 'is-live' : '')}>{isAuthorized && connectionStatus === 'opened' ? 'DERIV CONNECTED' : 'NOT CONNECTED'}</div>
            </header>

            <div className='over2-controls'>
                <label>Stake amount<input type='number' min='0.35' step='0.01' value={stake} onChange={e => setStake(e.target.value)} /></label>
                <label>Take profit<input type='number' min='0.01' step='0.01' value={takeProfit} onChange={e => setTakeProfit(e.target.value)} /></label>
                <label>Stop loss<input type='number' min='0.01' step='0.01' value={stopLoss} onChange={e => setStopLoss(e.target.value)} /></label>
                <label className='over2-toggle'><input type='checkbox' checked={martingaleEnabled} onChange={e => { setMartingaleEnabled(e.target.checked); setLossStep(0); }} /> Martingale 1.5×</label>
                <label>Account mode<select value={mode} onChange={e => changeMode(e.target.value as 'analysis' | 'demo' | 'live')}><option value='analysis'>Analysis only</option><option value='demo'>Demo automated</option><option value='live'>Live (explicit)</option></select></label>
            </div>

            <div className='over2-metrics'>
                <div><small>LIVE DIGIT</small><strong>{latest ? latest.digit : '—'}</strong><span>{latest ? latest.quote : 'Waiting for tick'}</span></div>
                <div><small>SELECTED DIGIT (OBSERVED)</small><strong>{current?.result.selectedDigit ?? '—'}</strong><span>{current ? current.market.name : 'Awaiting sample'}</span></div>
                <div><small>OVER 2 OBSERVED</small><strong>{current ? current.result.evidenceScore + '%' : '—'}</strong><span>{current ? current.result.overCount + ' / ' + current.result.sampleSize + ' ticks' : 'No sample yet'}</span></div>
                <div><small>SESSION P/L</small><strong className={sessionPnl >= 0 ? 'is-win' : 'is-loss'}>{sessionPnl.toFixed(2)} {currency}</strong><span>{wins} wins · {losses} losses · {winRate}% win rate</span></div>
            </div>

            <div className='over2-recovery'>
                <div className={recoveryLevel >= 1 ? 'is-active' : ''}><small>1ST RECOVERY</small><b>{recoveryLevel === 1 ? 'NEXT UP' : recoveryLevel > 1 ? 'COMPLETED' : 'READY'}</b></div>
                <div className={recoveryLevel >= 2 ? 'is-active' : ''}><small>2ND RECOVERY</small><b>{recoveryLevel === 2 ? 'NEXT UP' : recoveryLevel > 2 ? 'COMPLETED' : 'READY'}</b></div>
                <div className={recoveryLevel >= 3 ? 'is-active' : ''}><small>3RD RECOVERY</small><b>{recoveryLevel === 3 ? 'NEXT UP' : cooldown ? 'COMPLETED' : 'READY'}</b></div>
                <div className={cooldown ? 'is-cooldown' : ''}><small>4TH · COOLDOWN</small><b>{cooldown ? 'COOLDOWN ACTIVE' : 'NOT TRIGGERED'}</b></div>
            </div>

            <div className='over2-live-panel'>
                <div className='over2-panel-title'><div><h3>Strategy analysis and live market feed</h3><p>13 supported Volatility markets are checked in the background; the list stays off the dashboard.</p></div><span>{status}</span></div>
                <div className='over2-analysis-row'>
                    <div><small>SELECTED MARKET</small><b>{current?.market.name || 'Waiting for eligible market'}</b></div>
                    <div><small>CONTRACT</small><b>DIGITOVER · BARRIER 2</b></div>
                    <div><small>DECISION</small><b className={current?.result.status === 'READY' ? 'is-win' : current?.result.status === 'REJECTED' ? 'is-loss' : ''}>{current?.result.status || 'WAIT'}</b></div>
                    <div><small>STAKE IN USE</small><b>{effectiveStake.toFixed(2)} {currency}</b></div>
                </div>
                <p className='over2-notice'>{notice}</p>
            </div>

            <div className='over2-results'>
                <div className='over2-win'><small>WIN 🏆</small><strong>{wins}</strong></div>
                <div className='over2-loss'><small>LOSS</small><strong>{losses}</strong></div>
                <div className='over2-execution'><small>EXECUTION / SETTLEMENT</small><strong>{executionStatus}</strong></div>
            </div>

            <div className='over2-actions'>
                <button type='button' className='over2-start' onClick={start} disabled={running || cooldown}>START BOT</button>
                <button type='button' className='over2-stop' onClick={stop} disabled={!running && !executionArmed}>STOP BOT</button>
                <button type='button' className='over2-reset' onClick={resetCooldown} disabled={!cooldown && recoveryLevel === 0 && !trades.length}>RESET SESSION</button>
            </div>

            <div className='over2-journal'>
                <h3>Recent verified contracts</h3>
                {trades.length ? trades.slice(0, 6).map(row => <div key={row.id}><span>{row.symbol} · {row.contractId ? '#' + row.contractId : 'Pending'}</span><b className={row.status === 'WON' ? 'is-win' : row.status === 'LOST' ? 'is-loss' : ''}>{row.status}</b><strong>{row.profit === undefined ? '—' : row.profit.toFixed(2) + ' ' + currency}</strong></div>) : <p>No contracts have been executed in this session.</p>}
            </div>
            <p className='over2-disclaimer'>Observed digit frequency is historical sample data, not the probability of the next tick. Automated trading can lose money. Live execution remains disabled until the user explicitly selects Live and confirms the warning.</p>
        </section>
    );
};

export default OverTwoTerminal;
