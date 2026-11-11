import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { validateTick } from './even-odd-analysis-engine';
import { runParityPipeline } from './even-odd-parity-engine';
import { advanceMartingaleAfterSettlement, calculateParityStake, MAX_MARTINGALE_STEPS } from './even-odd-martingale';
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
    if (pipSize === undefined || !Number.isFinite(pipSize) || pipSize < 0) return -1;
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
    const [martingaleEnabled, setMartingaleEnabled] = useState(false);
    const [lossProgression, setLossProgression] = useState(0);
    const [recoveryStep, setRecoveryStep] = useState(0);
    const [cooldown, setCooldown] = useState(false);
    const effectiveStake = calculateParityStake(Number(stake), martingaleEnabled, lossProgression);
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
            setNotice('Waiting for Deriv active-symbol data.');
            return;
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
        maxTradesPerSession: 10,
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
            const martingaleProgress = advanceMartingaleAfterSettlement(lossProgression, result.settlement, martingaleEnabled);
            setLossProgression(martingaleProgress.nextStep);
            const nextRecoveryStep = result.settlement === 'WON' ? 0 : result.settlement === 'LOST' ? recoveryStep + 1 : recoveryStep;
            if (result.settlement === 'WON') setRecoveryStep(0);
            else if (result.settlement === 'LOST') setRecoveryStep(nextRecoveryStep);
            const nextSessionPnl = sessionPnl + result.profit;
            const nextTradeCount = tradesThisSession + 1;
            const withinSessionLimits = Math.max(0, -nextSessionPnl) < Number(stopLoss) && Math.max(0, nextSessionPnl) < Number(takeProfit) && nextTradeCount < 10;
            if (result.settlement === 'LOST' && recoveryStep >= 3) {
                setCooldown(true);
                executionAllowed.current = false;
                setExecutionArmed(false);
                autoRestartAllowed.current = false;
                setAutoRestart(false);
                setRunning(false);
                setExecutionStatus('Fourth consecutive recovery loss · cooldown active.');
                setNotice('The fourth loss has reached the recovery cooldown. Reset only after reviewing the session.');
            } else if (martingaleProgress.halt) {
                executionAllowed.current = false;
                setExecutionArmed(false);
                autoRestartAllowed.current = false;
                setAutoRestart(false);
                setRunning(false);
                setExecutionStatus('Martingale limit reached · bot paused after the maximum three 1.5× progression steps.');
                setNotice('Martingale safety limit reached. No further trade will be placed; review the session before manually restarting.');
            } else if (autoRestartAllowed.current && executionAllowed.current && withinSessionLimits) {
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
    }, [executionArmed, pipeline.executionAuthorized, pipeline.contractType, selected?.symbol, latest?.epoch, pipeline.selectedParity, pipeline.evidenceScore, mode, stake, effectiveStake, martingaleEnabled, autoRestart, stopLoss, takeProfit, sessionPnl, authData?.currency, authData?.is_virtual, authData?.loginid, isAuthorized, connectionStatus, tradesThisSession, recoveryStep]);

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
        setLossProgression(0);
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
        if (cooldown) { setNotice('Recovery cooldown is active after the fourth loss. Reset the session after manual review.'); return; }
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

    const resetRecovery = () => {
        setCooldown(false);
        setRecoveryStep(0);
        setLossProgression(0);
        setSessionPnlByAccount(previous => ({ ...previous, [activeLoginid]: 0 }));
        setTradeCountByAccount(previous => ({ ...previous, [activeLoginid]: 0 }));
        setExecutionStatus('Recovery and session counters reset after manual review.');
        setNotice('Recovery stages reset. Review the account and risk settings before restarting.');
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
                            <span>Background market scan</span>
                            <strong>{symbols.length} supported markets · best evidence candidate selected automatically</strong>
                        </div>
                        <div className='eo-terminal__stats'>
                            <div><span>Latest digit</span><strong>{latest ? latest.digit : '—'}</strong></div>
                            <div><span>Even observations</span><strong>{counts.even}</strong></div>
                            <div><span>Odd observations</span><strong>{counts.odd}</strong></div>
                            <div><span>Analysis sample</span><strong>{total}/30</strong></div>
                        </div>
                        <div className='eo-terminal__outcomes'>
                            <div><span>WIN 🏆</span><strong>{sessionWins}</strong></div>
                            <div><span>LOSS</span><strong>{sessionLosses}</strong></div>
                        </div>
                        <div className='eo-terminal__signal'>
                            <span>{selected?.name || 'Scanning markets'} · observed parity lead · evidence {pipeline.evidenceScore}%</span>
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
                        <label>Base stake amount<input type='number' min='0.35' step='0.01' value={stake} onChange={event => { setStake(event.target.value); setLossProgression(0); }} /></label>
                        <div className='eo-terminal__martingale'><div><strong>Martingale · 1.5×</strong><small>{martingaleEnabled ? `Enabled · loss step ${lossProgression}/${MAX_MARTINGALE_STEPS} · next stake ${effectiveStake.toFixed(2)} ${authData?.currency || ''}` : 'Disabled · fixed base stake'}</small></div><label className='eo-terminal__switch'><input type='checkbox' checked={martingaleEnabled} onChange={event => { setMartingaleEnabled(event.target.checked); setLossProgression(0); }} /><span>{martingaleEnabled ? 'ON' : 'OFF'}</span></label></div>
                        <div className='eo-terminal__recovery'>
                            <div className={recoveryStep >= 1 ? 'is-active' : ''}><small>1ST RECOVERY</small><b>{recoveryStep === 1 ? 'NEXT UP' : recoveryStep > 1 ? 'COMPLETED' : 'READY'}</b></div>
                            <div className={recoveryStep >= 2 ? 'is-active' : ''}><small>2ND RECOVERY</small><b>{recoveryStep === 2 ? 'NEXT UP' : recoveryStep > 2 ? 'COMPLETED' : 'READY'}</b></div>
                            <div className={recoveryStep >= 3 ? 'is-active' : ''}><small>3RD RECOVERY</small><b>{recoveryStep === 3 ? 'NEXT UP' : cooldown ? 'COMPLETED' : 'READY'}</b></div>
                            <div className={cooldown ? 'is-cooldown' : ''}><small>4TH · COOLDOWN</small><b>{cooldown ? 'ACTIVE' : 'NOT TRIGGERED'}</b></div>
                        </div>
                        <label>Stop-loss<input type='number' min='0' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} /></label>
                        <label>Take-profit<input type='number' min='0' step='0.01' value={takeProfit} onChange={event => setTakeProfit(event.target.value)} /></label>
                        <label>Execution mode<select value={mode} onChange={event => changeMode(event.target.value as 'analysis' | 'demo' | 'live')}><option value='analysis'>Analysis only</option><option value='demo'>Demo auto execution</option><option value='live'>Live auto execution</option></select></label>
                        <label className='eo-terminal__toggle'><input type='checkbox' checked={autoRestart} disabled={mode === 'analysis'} onChange={event => { autoRestartAllowed.current = event.target.checked; setAutoRestart(event.target.checked); }} /> Auto-restart after settlement (fresh sample required)</label>
                        <div className='eo-terminal__session-pnl'><span>Session P/L · Trades {tradesThisSession}/10</span><strong>{sessionPnl.toFixed(2)} {authData?.currency || ''}</strong></div>
                        <p className='eo-terminal__execution-status'>{executionStatus}</p>
                        
                        <p className='eo-terminal__disclaimer'>Stake, stop-loss and take-profit are enforced by the session risk gate. One trade per fresh sample · max 10 per session. Optional Martingale is capped at three 1.5× loss steps and remains subject to the same 2% balance exposure gate; it can be blocked when the next stake exceeds that limit.</p>
                        <button type='button' onClick={startFreshAnalysis} disabled={running || executionLock.current}>Start analysis</button>
                        <button type='button' className='eo-terminal__arm' onClick={armOneTrade} disabled={executionArmed || executionLock.current}>Run bot · guarded execution</button>
                        <button type='button' className='eo-terminal__stop' onClick={stopBot} disabled={!running && !executionArmed && !executionLock.current}>Stop / disarm</button>
                        <button type='button' className='eo-terminal__reset' onClick={resetRecovery} disabled={!cooldown && recoveryStep === 0 && lossProgression === 0}>Reset recovery</button>
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
                                <path d='M25 30Q17 17 33 10Q48 3 63 10Q79 17 71 30L77 58Q74 76 64 87L59 77L64 49Q62 28 48 25Q34 28 32 49L37 77L31 87Q22 76 19 58Z' fill='#124b32' stroke='#0d6039' strokeWidth='2'/>
                                <path d='M29 26Q48 13 67 26L72 52Q68 72 48 78Q28 72 24 52Z' fill='#f7fff9' stroke='#287c4d' strokeWidth='2'/>
                                <path d='M25 34 16 26 21 48 27 49M71 34 80 26 75 48 69 49' fill='url(#eo-android-glow)' stroke='#145c38' strokeWidth='2'/>
                                <path d='M31 40Q39 34 44 40M52 40Q59 34 65 40' fill='none' stroke='#17683f' strokeWidth='2.5' strokeLinecap='round'/>
                                <path d='M33 44 30 41M43 44 45 41M54 41 56 44M64 41 66 44' fill='none' stroke='#17683f' strokeWidth='1.5' strokeLinecap='round'/>
                                <ellipse cx='38' cy='48' rx='4' ry='3' fill='#16834a'/><ellipse cx='59' cy='48' rx='4' ry='3' fill='#16834a'/>
                                <path d='M48 48 45 57 51 57M39 65Q48 70 57 65' fill='none' stroke='#397e56' strokeWidth='2' strokeLinecap='round'/>
                                <path d='M28 57 34 62M68 57 62 62' fill='none' stroke='#8ac9a0' strokeWidth='2' strokeLinecap='round'/>
                                <path d='M36 9 48 3 60 9 56 20 40 20Z' fill='url(#eo-android-glow)' stroke='#247a4b' strokeWidth='2'/>
                                <path d='M44 4 48 0 52 4' fill='none' stroke='#baf2cf' strokeWidth='2'/>
                            </svg>
                        </div>
                        <div><strong>Parity intelligence</strong><span>Parity analysis and execution controls</span></div>
                    </div>
                </aside>
            </div>
            <footer className='eo-terminal__notice'>{notice} <strong>{mode === 'analysis' ? 'Analysis-only mode · no trades will be placed.' : `${mode.toUpperCase()} mode · execution requires an armed bot and every safety gate.`}</strong></footer>
        </section>
    );
};

export default EvenOddTerminal;
