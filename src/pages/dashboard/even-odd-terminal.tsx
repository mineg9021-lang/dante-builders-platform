import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { validateTick } from './even-odd-analysis-engine';
import { runParityPipeline } from './even-odd-parity-engine';
import { executeParityContract, type DerivParityApi, type ParityContractType } from './even-odd-parity-execution';
import './even-odd-terminal.scss';
import { isDanteVolatilitySymbol } from './market-universe';

type TickMessage = {
    msg_type?: string;
    tick?: { symbol?: string; quote?: number | string; epoch?: number };
    error?: { message?: string };
};

type TickRecord = { digit: number; quote: string; epoch: number };
type SymbolState = { symbol: string; name: string; precision: number; ticks: TickRecord[]; status: string };
type TradeJournalRow = { id: string; accountId: string; contractId?: number; contractType?: ParityContractType; symbol: string; buyPrice?: number; status: 'SKIPPED' | 'EXECUTED' | 'WON' | 'LOST' | 'VOID'; profit?: number; createdAt: number; settledAt?: number; sampleSize?: number; evenCount?: number; oddCount?: number; evidenceScore?: number; reason?: string };

const MAX_TICKS = 30;
const MAX_ANALYSIS_DURATION_MS = 10_000;

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
    const [stake, setStake] = useState('1');
    const effectiveStake = Number(stake);
    const [numberOfRuns, setNumberOfRuns] = useState('10');
    const [maxConsecutiveLosses, setMaxConsecutiveLosses] = useState('2');
    const [stopLoss, setStopLoss] = useState('10');
    const [takeProfit, setTakeProfit] = useState('10');
    const [running, setRunning] = useState(false);
    const [mode, setMode] = useState<'analysis' | 'demo' | 'live'>('analysis');
    useEffect(() => {
        // Demo accounts open in demo mode for a one-click guarded bot run; real accounts stay analysis-only until Live is explicitly selected.
        if (authData?.is_virtual && mode === 'analysis') setMode('demo');
    }, [authData?.loginid, authData?.is_virtual, mode]);
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
        if (connectionStatus !== 'opened' && (executionArmed || running)) {
            executionAllowed.current = false;
            setExecutionArmed(false);
            autoRestartAllowed.current = false;
            setAutoRestart(false);
            setRunning(false);
            setExecutionStatus('Stopped · Deriv connection closed; any accepted contract will still be monitored.');
        }
    }, [connectionStatus, executionArmed, running]);

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
            return isDanteVolatilitySymbol(symbol);
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
            setNotice('Waiting for Deriv active-symbol data. The 10-second analysis limit is active.');
            const unavailableTimeout = window.setTimeout(() => {
                setExecutionArmed(false);
                executionAllowed.current = false;
                setRunning(false);
                setExecutionStatus('WAIT · no active markets were available before the analysis timeout.');
                setNotice('Analysis timed out because Deriv did not return active market symbols. No trade was placed.');
            }, MAX_ANALYSIS_DURATION_MS);
            return () => window.clearTimeout(unavailableTimeout);
        }

        const initial: SymbolState[] = availableSymbols.map((item: any) => {
            const symbol = String(item.symbol || item.underlying_symbol || '');
            return {
                symbol,
                name: item.display_name || item.symbol_display_name || item.underlying_symbol_name || symbol,
                precision: Number(api_base.pip_sizes[symbol] ?? getPrecision(Number(item.pip_size || item.pip))),
                ticks: [],
                status: 'Connecting',
            };
        });
        setSymbols(initial);

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
            // Subscribe to the full configured 13-market universe; each stream is isolated by its canonical symbol.
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
        setNotice(executionArmed
            ? `BOT RUNNING · collecting up to ${MAX_TICKS} valid ticks per market across ${initial.length} supported Volatility streams; a Deriv proposal is requested only when signal and risk checks pass.`
            : `Analysis scan active · collecting up to ${MAX_TICKS} valid ticks per market across ${initial.length} supported Volatility streams. Select Demo or Live and press Run bot to enable guarded execution.`);
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
        if (running && symbols.length > 0 && symbols.every(item => item.ticks.length >= MAX_TICKS || item.status === 'Unavailable')) {
            setNotice('All available market samples completed. The bounded scan has stopped.');
            setRunning(false);
        }
    }, [running, symbols]);

    const parityConfig = {
        mode,
        armed: executionArmed,
        authorized: isAuthorized && connectionStatus === 'opened',
        demoAccount: Boolean(authData?.is_virtual),
        maxTicks: MAX_TICKS,
        minSample: 30,
        minLead: 0.12,
        minStableRatio: 1,
        stake: effectiveStake,
        availableBalance: Number(authData?.balance || 0),
        maxStakePercent: 2,
        sessionLoss: Math.max(0, -sessionPnl),
        sessionProfit: Math.max(0, sessionPnl),
        tradesThisSession,
        maxTradesPerSession: Math.max(1, Number(numberOfRuns) || 1),
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
    };
    const rankedMarkets = symbols.map(market => ({
        market,
        result: runParityPipeline({
            symbol: market.symbol,
            ticks: market.ticks.map(tick => ({
                symbol: market.symbol,
                quote: tick.quote,
                epoch: tick.epoch,
                digit: tick.digit,
                parity: tick.digit % 2 === 0 ? 'EVEN' as const : 'ODD' as const,
            })),
            config: parityConfig,
        }),
    })).sort((a, b) => {
        if (a.result.executionAuthorized !== b.result.executionAuthorized) return a.result.executionAuthorized ? -1 : 1;
        if (a.result.evidenceScore !== b.result.evidenceScore) return b.result.evidenceScore - a.result.evidenceScore;
        return b.result.sampleSize - a.result.sampleSize;
    });
    const selected = rankedMarkets[0]?.market;
    const pipeline = rankedMarkets[0]?.result || runParityPipeline({ symbol: '', ticks: [], config: parityConfig });
    const counts = { even: pipeline.evenCount, odd: pipeline.oddCount };
    const total = pipeline.sampleSize;
    const candidateReady = pipeline.stages[9]?.status === 'PASS' && pipeline.stages[10]?.status === 'PASS' && pipeline.sampleSize >= 30;
    const prediction = candidateReady ? `${pipeline.selectedParity} LEADING` : 'WAIT';
    const latest = selected?.ticks[selected.ticks.length - 1];
    const accountJournal = tradeJournal.filter(row => row.accountId === activeLoginid);
    const sessionWins = accountJournal.filter(row => row.status === 'WON').length;
    const sessionLosses = accountJournal.filter(row => row.status === 'LOST').length;

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
            stake: effectiveStake,
            currency: authData.currency,
            mode,
            executionPermission: pipeline.executionAuthorized,
            authorized: isAuthorized && connectionStatus === 'opened',
            isVirtual: Boolean(authData.is_virtual),
            lastTickEpoch: latest?.epoch || 0,
            shouldContinue: () => executionAllowed.current,
            onPurchased: purchase => {
                journaledSample.current = `${selected.symbol}:${latest?.epoch || 0}`;
                setTradeJournal(previous => [{ ...purchase, id: String(purchase.contractId), accountId: activeLoginid, status: 'EXECUTED' as const }, ...previous].slice(0, 50));
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
    }, [executionArmed, pipeline.executionAuthorized, pipeline.contractType, selected?.symbol, latest?.epoch, pipeline.selectedParity, pipeline.evidenceScore, mode, stake, effectiveStake, autoRestart, stopLoss, takeProfit, sessionPnl, authData?.currency, authData?.is_virtual, authData?.loginid, isAuthorized, connectionStatus, tradesThisSession]);

    useEffect(() => {
        if (selected && latest && selected.ticks.length >= MAX_TICKS && !running && !pipeline.executionAuthorized) {
            const sampleKey = `${selected.symbol}:${latest.epoch}`;
            if (journaledSample.current !== sampleKey) {
                journaledSample.current = sampleKey;
                setTradeJournal(previous => [{
                    id: `scan-${sampleKey}`,
                    accountId: activeLoginid,
                    symbol: selected.symbol,
                    status: 'SKIPPED' as const,
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

    const consecutiveLossCount = accountJournal.reduce((count, row, index) => index === count && row.status === 'LOST' ? count + 1 : count, 0);

    const armOneTrade = () => {
        if (consecutiveLossCount >= Math.max(1, Number(maxConsecutiveLosses) || 1)) { setNotice('Maximum consecutive losses reached. Review the session before starting again.'); return; }
        if (mode === 'analysis') {
            setNotice('Choose Demo or Live mode before arming execution. Analysis mode never places orders.');
            return;
        }
        if (!isAuthorized || connectionStatus !== 'opened') {
            setNotice('Connect and authorize your Deriv account with an open WebSocket before arming execution.');
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
        setExecutionStatus('RUNNING · collecting a fresh 30-tick sample, then requesting a Deriv proposal when all entry and risk gates pass');
        executionAllowed.current = true;
        setExecutionArmed(true);
        setNotice('Bot is running. It will submit one Deriv trade only after the selected market produces a fresh validated signal and all account and risk checks pass.');
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
        <section className='eo-terminal eo-terminal--prime' id='prime-parity-bot'>
            <header className='eo-terminal__header'>
                <div className='eo-terminal__brand'>
                    <span className='eo-terminal__bolt'>ϟ</span>
                    <div><span className='eo-terminal__eyebrow'>PRIME PARITY ENGINE</span><h2>Even / Odd Bot</h2><p>Fixed-stake parity trading across supported Volatility markets</p></div>
                </div>
                <div className={`eo-terminal__connection ${isAuthorized && connectionStatus === 'opened' ? 'is-live' : ''}`}><span />{isAuthorized && connectionStatus === 'opened' ? 'DERIV CONNECTED' : 'OFFLINE'}</div>
            </header>

            <div className='eo-prime-timers'>
                <div><small>ENGINE STATUS</small><strong>{running ? 'Running' : executionLock.current ? 'Settling' : 'Idle'}</strong></div>
                <div><small>ANALYSIS WINDOW</small><strong>10 seconds max</strong></div>
            </div>

            <nav className='eo-prime-tabs'><span className='is-active'>Trading Bot</span><span>Trading History · {accountJournal.length}</span></nav>

            <div className='eo-prime-balance'><div><small>ACCOUNT BALANCE</small><strong>{authData?.balance !== undefined ? Number(authData.balance).toFixed(2) : '—'}</strong><span>{authData?.currency || 'Connect Deriv to load balance'}</span></div><div className='eo-prime-wallet'>▣</div></div>

            <div className='eo-prime-config'>
                <h3>Configuration</h3>
                <div className='eo-prime-fields'>
                    <label>STAKE ({authData?.currency || '$'})<input type='number' min='0.35' step='0.01' value={stake} onChange={event => setStake(event.target.value)} /></label>
                    <label>NUMBER OF RUNS<input type='number' min='1' max='100' step='1' value={numberOfRuns} onChange={event => setNumberOfRuns(event.target.value)} /></label>
                    <label>TARGET PROFIT ({authData?.currency || '$'})<input type='number' min='0.01' step='0.01' value={takeProfit} onChange={event => setTakeProfit(event.target.value)} /></label>
                    <label>STOP LOSS ({authData?.currency || '$'})<input type='number' min='0.01' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} /></label>
                    <label>MAX CONSECUTIVE LOSSES<input type='number' min='1' max='20' step='1' value={maxConsecutiveLosses} onChange={event => setMaxConsecutiveLosses(event.target.value)} /></label>
                    <label>ACCOUNT MODE<select value={mode} onChange={event => changeMode(event.target.value as 'analysis' | 'demo' | 'live')}><option value='analysis'>Analysis only</option><option value='demo'>Demo account</option><option value='live'>Real account · explicit opt-in</option></select></label>
                </div>
                <div className='eo-prime-actions'>
                    <button type='button' onClick={armOneTrade} disabled={executionArmed || executionLock.current || running}>START BOT</button>
                    <button type='button' className='eo-terminal__stop' onClick={stopBot} disabled={!running && !executionArmed && !executionLock.current}>STOP BOT</button>
                </div>
                <p className='eo-terminal__execution-status'>{executionStatus}</p>
                <p className='eo-terminal__disclaimer'>No API token is entered or displayed here. Connect using the secure Deriv authorization flow. Martingale is not used. Orders are blocked until account, market, entry and risk checks pass.</p>
            </div>

            <div className='eo-prime-results'>
                <div className='eo-prime-result-heading'><h3>Trade Results</h3><span>Verified Deriv settlements only</span></div>
                <div className='eo-prime-result-grid'>
                    <div className='eo-prime-result eo-prime-result--win'><small>WIN 🏆</small><strong>{sessionWins}</strong><span>{accountJournal.find(row => row.status === 'WON')?.contractType || 'Awaiting verified win'}</span></div>
                    <div className='eo-prime-result eo-prime-result--loss'><small>LOSS</small><strong>{sessionLosses}</strong><span>{accountJournal.find(row => row.status === 'LOST')?.contractType || 'Awaiting verified loss'}</span></div>
                </div>
                <div className='eo-prime-prediction'><div><small>SELECTED PARITY CANDIDATE</small><strong>{candidateReady ? pipeline.selectedParity : 'WAIT'}</strong><span>{selected?.name || 'No market selected'} · sample {total}/30 · observed evidence {pipeline.evidenceScore}%</span></div><div><small>LATEST OBSERVED DIGIT</small><strong>{latest ? latest.digit : '—'}</strong><span>{latest ? (latest.digit % 2 === 0 ? 'EVEN' : 'ODD') : 'No validated tick yet'}</span></div></div>
                <div className='eo-prime-markets'><div className='eo-prime-result-heading'><h3>Volatility Markets</h3><span>{availableSymbols.length}/13 active in Deriv catalogue</span></div>
                    {availableSymbols.map((item: any) => { const symbol = String(item.symbol || item.underlying_symbol || ''); const market = symbols.find(row => row.symbol === symbol); const isSelected = selected?.symbol === symbol; return <div className='eo-prime-market-row' key={symbol}><span>{item.display_name || item.symbol_display_name || symbol}</span><small>{market?.ticks.length || 0}/30 ticks · {market?.status || 'Standby'}</small><b className={isSelected ? 'is-selected' : ''}>{isSelected ? 'SELECTED' : market?.status === 'Unavailable' ? 'UNAVAILABLE' : 'MONITOR'}</b></div>; })}
                    {!availableSymbols.length && <p className='eo-terminal__journal-empty'>Connect Deriv to retrieve the active market catalogue and monitor the 13 configured indices.</p>}
                </div>
                <div className='eo-prime-history'><div className='eo-prime-result-heading'><h3>Trading History</h3><span>{accountJournal.length} records</span></div>
                    {accountJournal.slice(0,10).map(row => <div className='eo-terminal__journal-row' key={row.id}><div><strong>{row.symbol} · {row.contractType || 'PARITY'}</strong><small>{row.contractId ? 'Contract #' + row.contractId : row.reason || 'Analysis record'} · {new Date(row.createdAt).toLocaleTimeString()}</small></div><b className={`eo-terminal__journal-status eo-terminal__journal-status--${row.status.toLowerCase()}`}>{row.status}</b><span>{row.profit === undefined ? '—' : row.profit.toFixed(2)}</span></div>)}
                    {!accountJournal.length && <p className='eo-terminal__journal-empty'>No verified trades yet. Results appear here after Deriv settlement.</p>}
                </div>
            </div>
            <footer className='eo-terminal__notice'>{notice}</footer>
        </section>
    );
};

export default EvenOddTerminal;
