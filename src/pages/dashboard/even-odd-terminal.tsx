import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { validateTick } from './even-odd-analysis-engine';
import { runParityPipeline } from './even-odd-parity-engine';
import { executeParityContract, type DerivParityApi, type ParityContractType } from './even-odd-parity-execution';
import './even-odd-terminal.scss';

type TickMessage = {
    msg_type?: string;
    tick?: { symbol?: string; quote?: number | string; epoch?: number };
    error?: { message?: string };
};

type TickRecord = { digit: number; quote: string; epoch: number };
type SymbolState = { symbol: string; name: string; precision: number; ticks: TickRecord[]; status: string };
type TradeJournalRow = { id: string; accountId: string; contractId?: number; contractType?: ParityContractType; symbol: string; buyPrice?: number; status: 'SKIPPED' | 'EXECUTED' | 'WON' | 'LOST' | 'VOID'; profit?: number; createdAt: number; settledAt?: number; sampleSize?: number; evenCount?: number; oddCount?: number; evidenceScore?: number; reason?: string };

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
    const [mode, setMode] = useState<'analysis' | 'demo' | 'live'>('analysis');
    const [executionArmed, setExecutionArmed] = useState(false);
    const [autoRestart, setAutoRestart] = useState(false);
    const [executionStatus, setExecutionStatus] = useState('Not armed');
    const [tradeJournal, setTradeJournal] = useState<TradeJournalRow[]>(() => {
        try {
            const saved = window.localStorage.getItem('dante-parity-trade-journal');
            const parsed = saved ? JSON.parse(saved) : [];
            return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
        } catch {
            return [];
        }
    });
    const [sessionPnlByAccount, setSessionPnlByAccount] = useState<Record<string, number>>(() => {
        try {
            const saved = window.sessionStorage.getItem('dante-parity-session-pnl');
            const parsed = saved ? JSON.parse(saved) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    });
    const activeLoginid = authData?.loginid || '';
    const sessionPnl = activeLoginid ? Number(sessionPnlByAccount[activeLoginid] || 0) : 0;
    const [tradeCountByAccount, setTradeCountByAccount] = useState<Record<string, number>>(() => {
        try {
            const saved = window.sessionStorage.getItem('dante-parity-session-trades');
            const parsed = saved ? JSON.parse(saved) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    });
    const tradesThisSession = activeLoginid ? Number(tradeCountByAccount[activeLoginid] || 0) : 0;
    const executionLock = useRef(false);
    const executionAllowed = useRef(false);
    const autoRestartAllowed = useRef(false);
    const consumedSample = useRef('');
    const journaledSample = useRef('');
    const lastAccountId = useRef('');
    const [notice, setNotice] = useState('Connect your Deriv account to start live market analysis.');
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    useEffect(() => {
        if (lastAccountId.current && activeLoginid && lastAccountId.current !== activeLoginid) {
            executionAllowed.current = false;
            setExecutionArmed(false);
            autoRestartAllowed.current = false;
            setAutoRestart(false);
            setRunning(false);
            setExecutionStatus('Disarmed · Deriv account changed; review account mode and start a fresh scan.');
        }
        lastAccountId.current = activeLoginid;
    }, [activeLoginid]);

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
            const name = String(item.display_name || item.symbol_display_name || item.underlying_symbol_name || '');
            const symbol = String(item.symbol || item.underlying_symbol || '');
            return /volatility/i.test(name) && Boolean(symbol);
        });
    }, [connectionStatus, isAuthorized, lastUpdated]);

    const availableSymbolKey = availableSymbols.map((item: any) => item.symbol || item.underlying_symbol).join('|');

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
            symbol: item.symbol || item.underlying_symbol,
            name: item.display_name || item.symbol_display_name || item.underlying_symbol_name || item.symbol || item.underlying_symbol,
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
                setNotice('Analysis time limit reached. The bounded scan has stopped without forcing a trade.');
                executionAllowed.current = false;
                setExecutionArmed(false);
                autoRestartAllowed.current = false;
                setAutoRestart(false);
                setExecutionStatus('WAIT · scan timeout; no order was placed.');
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
            mode,
            armed: executionArmed,
            authorized: isAuthorized,
            demoAccount: Boolean(authData?.is_virtual),
            maxTicks: MAX_TICKS,
            minSample: 30,
            minLead: 0.12,
            minStableRatio: 1,
            stake: Number(stake),
            availableBalance: Number(authData?.balance || 0),
            maxStakePercent: 2,
            sessionLoss: Math.max(0, -sessionPnl),
            sessionProfit: Math.max(0, sessionPnl),
            tradesThisSession,
            maxTradesPerSession: 10,
            stopLoss: Number(stopLoss),
            takeProfit: Number(takeProfit),
        },
    });
    const counts = { even: pipeline.evenCount, odd: pipeline.oddCount };
    const total = pipeline.sampleSize;
    const candidateReady = pipeline.stages[9]?.status === 'PASS' && pipeline.stages[10]?.status === 'PASS' && pipeline.sampleSize >= 30;
    const prediction = candidateReady ? `${pipeline.selectedParity} LEADING` : 'WAIT';
    const latest = selected?.ticks[selected.ticks.length - 1];
    const accountJournal = tradeJournal.filter(row => row.accountId === activeLoginid);

    useEffect(() => {
        try {
            window.localStorage.setItem('dante-parity-trade-journal', JSON.stringify(tradeJournal.slice(0, 50)));
        } catch {
            // Journal persistence is best-effort; trading safety does not depend on local storage.
        }
    }, [tradeJournal]);

    useEffect(() => {
        try {
            window.sessionStorage.setItem('dante-parity-session-pnl', JSON.stringify(sessionPnlByAccount));
        } catch {
            // Session P/L persistence is best-effort; execution still checks the current in-memory value.
        }
    }, [sessionPnlByAccount]);

    useEffect(() => {
        try {
            window.sessionStorage.setItem('dante-parity-session-trades', JSON.stringify(tradeCountByAccount));
        } catch {
            // Session trade count persistence is best-effort; order execution remains gated in memory.
        }
    }, [tradeCountByAccount]);

    useEffect(() => {
        if (!executionArmed || !pipeline.executionAuthorized || executionLock.current || !selected || !pipeline.contractType) return;
        if (!api_base.api || !authData?.currency) {
            setExecutionStatus('Blocked: Deriv connection or account currency is unavailable.');
            executionAllowed.current = false;
            setExecutionArmed(false);
            autoRestartAllowed.current = false;
            setAutoRestart(false);
            return;
        }
        const sampleKey = `${selected.symbol}:${latest?.epoch || 0}:${pipeline.selectedParity}:${pipeline.evidenceScore}`;
        if (consumedSample.current === sampleKey) {
            setExecutionStatus('This sample was already used. Start a fresh analysis before another trade.');
            executionAllowed.current = false;
            setExecutionArmed(false);
            autoRestartAllowed.current = false;
            setAutoRestart(false);
            return;
        }
        consumedSample.current = sampleKey;
        executionLock.current = true;
        setExecutionStatus(`Submitting one ${mode.toUpperCase()} ${pipeline.contractType} contract…`);
        executeParityContract({
            api: api_base.api as unknown as DerivParityApi,
            symbol: selected.symbol,
            contractType: pipeline.contractType,
            stake: Number(stake),
            currency: authData.currency,
            mode,
            executionPermission: pipeline.executionAuthorized,
            authorized: isAuthorized,
            isVirtual: Boolean(authData.is_virtual),
            lastTickEpoch: latest?.epoch || 0,
            shouldContinue: () => executionAllowed.current,
            onPurchased: purchase => {
                journaledSample.current = `${selected.symbol}:${latest?.epoch || 0}`;
                setTradeJournal(previous => [{ ...purchase, id: String(purchase.contractId), accountId: activeLoginid, status: 'EXECUTED' }, ...previous].slice(0, 50));
                if (activeLoginid) setTradeCountByAccount(previous => ({ ...previous, [activeLoginid]: Number(previous[activeLoginid] || 0) + 1 }));
            },
            timeoutMs: 90_000,
        }).then(result => {
            if (activeLoginid) {
                setSessionPnlByAccount(previous => ({
                    ...previous,
                    [activeLoginid]: Number(previous[activeLoginid] || 0) + result.profit,
                }));
            }
            setTradeJournal(previous => previous.map(row => row.contractId === result.contractId
                ? { ...row, status: result.settlement, profit: result.profit, settledAt: result.settledAt }
                : row));
            setExecutionStatus(`${result.settlement} · ${result.contractType} · P/L ${result.profit.toFixed(2)} ${authData.currency}`);
            const nextSessionPnl = sessionPnl + result.profit;
            const nextTradeCount = tradesThisSession + 1;
            const withinSessionLimits = Math.max(0, -nextSessionPnl) < Number(stopLoss) && Math.max(0, nextSessionPnl) < Number(takeProfit) && nextTradeCount < 10;
            if (autoRestartAllowed.current && executionAllowed.current && withinSessionLimits) {
                setSymbols([]);
                executionAllowed.current = true;
                setExecutionArmed(true);
                setRunning(true);
                setExecutionStatus(`${result.settlement} · starting a new bounded scan for the next setup`);
                setNotice(`Contract ${result.contractId} settled. Auto-restart is active; the bot will wait for a fresh validated sample.`);
            } else {
                executionAllowed.current = false;
                setExecutionArmed(false);
                autoRestartAllowed.current = false;
                setAutoRestart(false);
                setRunning(false);
                setNotice(`Contract ${result.contractId} settled as ${result.settlement}. The bot is disarmed; start a fresh scan before another trade.`);
            }
        }).catch(error => {
            const message = error instanceof Error ? error.message : 'Trade execution failed.';
            setExecutionStatus(`BLOCKED · ${message}`);
            setNotice(message);
            executionAllowed.current = false;
            setExecutionArmed(false);
            autoRestartAllowed.current = false;
            setAutoRestart(false);
            setRunning(false);
        }).finally(() => {
            executionLock.current = false;
        });
    }, [executionArmed, pipeline.executionAuthorized, pipeline.contractType, selected?.symbol, latest?.epoch, pipeline.selectedParity, pipeline.evidenceScore, mode, stake, autoRestart, stopLoss, takeProfit, sessionPnl, authData?.currency, authData?.is_virtual, authData?.loginid, isAuthorized, tradesThisSession]);

    useEffect(() => {
        if (selected && latest && selected.ticks.length >= MAX_TICKS && !running && !pipeline.executionAuthorized) {
            const sampleKey = `${selected.symbol}:${latest.epoch}`;
            if (journaledSample.current !== sampleKey) {
                journaledSample.current = sampleKey;
                setTradeJournal(previous => [{
                    id: `scan-${sampleKey}`,
                    accountId: activeLoginid,
                    symbol: selected.symbol,
                    status: 'SKIPPED',
                    createdAt: Date.now(),
                    sampleSize: pipeline.sampleSize,
                    evenCount: pipeline.evenCount,
                    oddCount: pipeline.oddCount,
                    evidenceScore: pipeline.evidenceScore,
                    reason: pipeline.reason,
                }, ...previous].slice(0, 50));
            }
        }
    }, [selected?.symbol, latest?.epoch, selected?.ticks.length, running, pipeline.executionAuthorized, pipeline.sampleSize, pipeline.evenCount, pipeline.oddCount, pipeline.evidenceScore, pipeline.reason, activeLoginid]);

    useEffect(() => {
        const sampleComplete = symbols.length > 0 && symbols.every(item => item.ticks.length >= MAX_TICKS);
        if (executionArmed && !running && sampleComplete && !pipeline.executionAuthorized) {
            executionAllowed.current = false;
            setExecutionArmed(false);
            autoRestartAllowed.current = false;
            setAutoRestart(false);
            setExecutionStatus('WAIT · no qualifying setup in the completed sample; no trade was placed.');
            setNotice('The bounded sample completed without a fully confirmed entry. The bot has disarmed safely.');
        }
    }, [executionArmed, running, symbols, pipeline.executionAuthorized]);

    const changeMode = (nextMode: 'analysis' | 'demo' | 'live') => {
        if (nextMode === 'live' && !window.confirm('Live mode can place real-money trades. Continue only if you understand the risk.')) return;
        setExecutionArmed(false);
        autoRestartAllowed.current = false;
        setAutoRestart(false);
        setMode(nextMode);
        setExecutionStatus(nextMode === 'analysis' ? 'Analysis only · orders disabled' : `${nextMode.toUpperCase()} mode · disarmed`);
    };

    const startFreshAnalysis = () => {
        setSymbols([]);
        executionAllowed.current = false;
        setExecutionArmed(false);
        autoRestartAllowed.current = false;
        setAutoRestart(false);
        setExecutionStatus('Not armed');
        setNotice('Starting a fresh bounded market scan…');
        setRunning(true);
    };

    const armOneTrade = () => {
        if (mode === 'analysis') {
            setNotice('Choose Demo or Live mode before arming execution. Analysis mode never places orders.');
            return;
        }
        if (!isAuthorized) {
            setNotice('Connect and authorize your Deriv account before arming execution.');
            return;
        }
        if (mode === 'demo' && !Boolean(authData?.is_virtual)) {
            setNotice('Switch to a Deriv demo account before selecting Demo mode.');
            return;
        }
        if (mode === 'live' && Boolean(authData?.is_virtual)) {
            setNotice('Switch to a Deriv real account before selecting Live mode.');
            return;
        }
        if (!running) setSymbols([]);
        setExecutionStatus('Armed · waiting for a fresh 30-tick sample and all safety checks');
        executionAllowed.current = true;
        setExecutionArmed(true);
        setNotice('Bot armed. It will wait for a fresh, validated candidate and only restart after settlement if auto-restart is enabled.');
        if (!running) setRunning(true);
    };

    const stopBot = () => {
        executionAllowed.current = false;
        setExecutionArmed(false);
        autoRestartAllowed.current = false;
        setAutoRestart(false);
        setRunning(false);
        setExecutionStatus(executionLock.current ? 'Disarmed · any already accepted buy cannot be recalled; monitoring will continue.' : 'Disarmed by user');
        setNotice(executionLock.current ? 'Bot disarmed. If a buy request was already accepted, the contract will still be monitored.' : 'Bot stopped. No further orders will be submitted.');
    };

    return (
        <section className='eo-terminal' id='parity-bot'>
            <header className='eo-terminal__header'>
                <div>
                    <span className='eo-terminal__eyebrow'>DANTE BUILDERS · MARKET INTELLIGENCE</span>
                    <h2>Even / Odd Parity Bot</h2>
                    <p>Live Deriv tick analysis, evidence scoring and guarded one-trade execution.</p>
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
                            <small>{prediction === 'WAIT' ? 'Insufficient sample or parity difference. No entry candidate.' : `Observed sample lead only · evidence difference ${pipeline.evidenceScore}% · not a next-tick forecast.`}</small>
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
                    <div className='eo-terminal__card eo-terminal__journal'>
                        <div className='eo-terminal__card-heading'><h3>Trading journal</h3><span>{accountJournal.length} saved records</span></div>
                        {accountJournal.length ? accountJournal.slice(0, 8).map(row => (
                            <div className='eo-terminal__journal-row' key={row.id}>
                                <div><strong>{row.symbol}{row.contractType ? ` · ${row.contractType}` : ''}</strong><small title={row.reason}>{row.contractId ? `Contract #${row.contractId} · ` : row.status === 'SKIPPED' ? `Skipped · ${row.sampleSize || 0} ticks · E ${row.evenCount || 0}/O ${row.oddCount || 0} · score ${row.evidenceScore || 0}% · ` : ''}{new Date(row.createdAt).toLocaleTimeString()}</small></div>
                                <b className={`eo-terminal__journal-status eo-terminal__journal-status--${row.status.toLowerCase()}`}>{row.status}</b>
                                <span>{row.profit === undefined ? '—' : row.profit.toFixed(2)}</span>
                            </div>
                        )) : <p className='eo-terminal__journal-empty'>No contracts executed yet. Analysis scans remain separate from executed trades.</p>}
                    </div>
                </div>

                <aside className='eo-terminal__side'>
                    <div className='eo-terminal__card'>
                        <h3>Risk configuration</h3>
                        <label>Stake amount<input type='number' min='0.35' step='0.01' value={stake} onChange={event => setStake(event.target.value)} /></label>
                        <label>Stop-loss<input type='number' min='0' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} /></label>
                        <label>Take-profit<input type='number' min='0' step='0.01' value={takeProfit} onChange={event => setTakeProfit(event.target.value)} /></label>
                        <label>Execution mode<select value={mode} onChange={event => changeMode(event.target.value as 'analysis' | 'demo' | 'live')}><option value='analysis'>Analysis only</option><option value='demo'>Demo auto execution</option><option value='live'>Live auto execution</option></select></label>
                        <label className='eo-terminal__toggle'><input type='checkbox' checked={autoRestart} disabled={mode === 'analysis'} onChange={event => { autoRestartAllowed.current = event.target.checked; setAutoRestart(event.target.checked); }} /> Auto-restart after settlement (fresh sample required)</label>
                        <div className='eo-terminal__session-pnl'><span>Session P/L · Trades {tradesThisSession}/10</span><strong>{sessionPnl.toFixed(2)} {authData?.currency || ''}</strong></div>
                        <p className='eo-terminal__execution-status'>{executionStatus}</p>
                        
                        <p className='eo-terminal__disclaimer'>Stake, stop-loss and take-profit are enforced by the session risk gate. One trade per fresh sample · max 10 per session. Auto-restart uses a new bounded sample; stop-loss, take-profit and trade-count limits still apply. No martingale or recovery progression.</p>
                        <button type='button' onClick={startFreshAnalysis} disabled={running || executionLock.current}>Start analysis</button>
                        <button type='button' className='eo-terminal__arm' onClick={armOneTrade} disabled={executionArmed || executionLock.current}>Arm bot</button>
                        <button type='button' className='eo-terminal__stop' onClick={stopBot} disabled={!running && !executionArmed && !executionLock.current}>Stop / disarm</button>
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
            <footer className='eo-terminal__notice'>{notice} <strong>{mode === 'analysis' ? 'Analysis-only mode · no trades will be placed.' : `${mode.toUpperCase()} mode · execution requires an armed bot and every safety gate.`}</strong></footer>
        </section>
    );
};

export default EvenOddTerminal;
