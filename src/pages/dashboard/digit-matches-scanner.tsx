import React, { useEffect, useMemo, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { analyzeDigitTicks, extractLastDigit, quoteWithPrecision, type DigitTick } from './digit-matches-engine';
import './digit-matches-scanner.scss';

const WINDOWS = [20, 50, 100, 200, 500, 1000];
const DigitMatchesScanner = () => {
 const { isAuthorized, connectionStatus } = useApiBase();
 const [symbol, setSymbol] = useState('R_10');
 const [windowSize, setWindowSize] = useState(100);
 const [ticks, setTicks] = useState<DigitTick[]>([]);
 const [status, setStatus] = useState<'STOPPED'|'CONNECTING'|'SCANNING'|'PAUSED'|'ERROR'>('STOPPED');
 const [error, setError] = useState('');
 const [revision, setRevision] = useState(0);
 const [scanRequested, setScanRequested] = useState(false);
 const activeSymbols = useMemo(() => (Array.isArray(api_base.active_symbols) ? api_base.active_symbols : []).filter((item: any) => /volatility/i.test(String(item.display_name || item.symbol_display_name || ''))), [revision, connectionStatus]);
 const marketOptions = activeSymbols.length ? activeSymbols : [
  {symbol:'R_10',display_name:'Volatility 10'},{symbol:'1HZ10V',display_name:'Volatility 10 (1s)'},
  {symbol:'R_25',display_name:'Volatility 25'},{symbol:'1HZ25V',display_name:'Volatility 25 (1s)'},
  {symbol:'R_50',display_name:'Volatility 50'},{symbol:'1HZ50V',display_name:'Volatility 50 (1s)'},
  {symbol:'R_75',display_name:'Volatility 75'},{symbol:'1HZ75V',display_name:'Volatility 75 (1s)'},
  {symbol:'R_100',display_name:'Volatility 100'},{symbol:'1HZ100V',display_name:'Volatility 100 (1s)'}
 ];
 const report = useMemo(() => analyzeDigitTicks({ticks, windowSize, minSample: Math.min(100, windowSize)}), [ticks, windowSize]);
 useEffect(() => {
  if (!scanRequested) return;
  if (!isAuthorized || connectionStatus !== 'opened' || !api_base.api) { setStatus('ERROR'); setError('Connect and authorize Deriv before starting the scanner.'); return; }
  let mounted = true;
  let subscriptionId: string | undefined;
  const sub = api_base.api.onMessage().subscribe((raw: any) => {
   if (!mounted || raw?.msg_type !== 'tick' || raw?.tick?.symbol !== symbol) return;
   try {
    const precision = Number(api_base.pip_sizes?.[symbol] ?? 2);
    const quote = quoteWithPrecision(raw.tick.quote, precision);
    const digit = extractLastDigit(quote);
    const epoch = Number(raw.tick.epoch);
    setTicks(previous => {
     if (!Number.isFinite(epoch) || (previous.length && epoch <= previous[previous.length - 1].epoch)) return previous;
     return [...previous, {symbol, quote, digit, epoch}].slice(-windowSize);
    });
   } catch { /* malformed source tick is rejected */ }
  });
  const start = async () => {
   try {
    const precision = Number(api_base.pip_sizes?.[symbol] ?? 2);
    const history = await (api_base.api!.send({ticks_history:symbol, count:windowSize, end:'latest', style:'ticks'}) as unknown as Promise<any>);
    if (!mounted) return;
    if (history?.error) throw new Error(history.error.message || 'Historical tick request failed');
    const prices: Array<string|number> = history?.history?.prices || [];
    const times: number[] = history?.history?.times || [];
    const historical: DigitTick[] = prices.map((price, index) => {
     const quote = quoteWithPrecision(price, precision);
     return {symbol, quote, digit:extractLastDigit(quote), epoch:Number(times[index])};
    }).filter(t => Number.isFinite(t.epoch));
    setTicks(historical.slice(-windowSize));
    const live = await (api_base.api!.send({ticks:symbol, subscribe:1}) as unknown as Promise<any>);
    if (!mounted) { if (live?.subscription?.id) void api_base.api?.send({forget:live.subscription.id}); return; }
    if (live?.error) throw new Error(live.error.message || 'Live tick subscription failed');
    subscriptionId = live?.subscription?.id;
    setError('');
    setStatus('SCANNING');
   } catch (e) { if (mounted) { setStatus('ERROR'); setError(e instanceof Error ? e.message : 'Scanner connection failed'); } }
  };
  setStatus('CONNECTING');
  void start();
  const refresh = window.setInterval(() => setRevision(v => v + 1), 1500);
  return () => {
   mounted = false; sub.unsubscribe(); window.clearInterval(refresh);
   if (subscriptionId) void api_base.api?.send({forget:subscriptionId});
  };
 }, [scanRequested, symbol, windowSize, isAuthorized, connectionStatus]);
 const start = () => { setTicks([]); setError(''); setStatus('CONNECTING'); setScanRequested(true); };
 const pause = () => { setScanRequested(false); setStatus('PAUSED'); };
 const stop = () => { setScanRequested(false); setStatus('STOPPED'); setTicks([]); setError(''); };
 const candidates = (kind:'MATCHES'|'DIFFERS') => kind === 'MATCHES' ? report.matches : report.differs;
 return <div className='dmi-scanner'>
  <div className='dmi-topline'><span className='dmi-kicker'>INDEPENDENT MARKET INTELLIGENCE</span><span className={`dmi-status dmi-status--${status.toLowerCase()}`}>● {status}</span></div>
  <div className='dmi-controls'>
   <label>Deriv market<select value={symbol} onChange={e=>{setScanRequested(false);setStatus('STOPPED');setSymbol(e.target.value);setTicks([]);}}>{marketOptions.map((m:any)=><option key={m.symbol} value={m.symbol}>{m.display_name || m.symbol}</option>)}</select></label>
   <label>Analysis window<select value={windowSize} onChange={e=>setWindowSize(Number(e.target.value))}>{WINDOWS.map(n=><option key={n} value={n}>{n} ticks</option>)}</select></label>
   <div className='dmi-actions'><button onClick={start} disabled={status==='SCANNING'}>Start scanner</button><button onClick={pause} disabled={status!=='SCANNING'}>Pause</button><button onClick={stop}>Stop</button></div>
  </div>
  {error && <p className='dmi-error' role='alert'>{error}</p>}
  <div className='dmi-kpis'><div><small>VALID TICKS</small><b>{report.sampleSize}</b></div><div><small>EVEN OBSERVED</small><b>{report.even}</b></div><div><small>ODD OBSERVED</small><b>{report.odd}</b></div><div><small>DATA QUALITY</small><b>{report.sampleSize ? 'ORDERED' : 'WAITING'}</b></div></div>
  <h3>Digit occurrence distribution</h3>
  <div className='dmi-digits'>{report.digits.map(d=><div key={d.digit}><b>{d.digit}</b><span>{d.count}</span><small>{(d.frequency*100).toFixed(1)}%</small><i><em style={{width:`${Math.max(0,Math.min(100,d.frequency*1000))}%`}} /></i></div>)}</div>
  <div className='dmi-candidate-grid'>{(['MATCHES','DIFFERS'] as const).map(kind=><section key={kind}><h3>{kind} candidate review</h3>{candidates(kind).sort((a,b)=>b.score-a.score).slice(0,5).map(c=><div className='dmi-candidate' key={c.digit}><strong>Digit {c.digit}</strong><span>{(c.observedRate*100).toFixed(1)}% observed</span><b>{c.status}</b></div>)}</section>)}</div>
  <div className='dmi-layers'><h3>20-stage scanner pipeline</h3><div>{report.layers.map((layer,i)=><span key={layer.name} className={layer.status==='PASS'?'is-pass':''}>{String(i+1).padStart(2,'0')} · {layer.name} <b>{layer.status}</b></span>)}</div></div>
  <p className='dmi-disclaimer'>Observed historical frequencies are descriptive statistics, not predictions of the next tick. Contract pricing and execution are not enabled in scanner mode.</p>
 </div>;
};
export default DigitMatchesScanner;
