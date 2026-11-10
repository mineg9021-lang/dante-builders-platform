import React, { useEffect, useMemo, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { analyzeDigitTicks, extractLastDigit, quoteWithPrecision, type DigitTick } from './digit-matches-engine';
import './digit-matches-scanner.scss';

const WINDOWS = [20, 50, 100, 200, 500, 1000];
const FALLBACK_CONTRACTS = [
 { contract_type: 'DIGITMATCH', label: 'Matches' }, { contract_type: 'DIGITDIFF', label: 'Differs' },
 { contract_type: 'DIGITEVEN', label: 'Even' }, { contract_type: 'DIGITODD', label: 'Odd' },
 { contract_type: 'DIGITOVER', label: 'Over' }, { contract_type: 'DIGITUNDER', label: 'Under' },
 { contract_type: 'CALL', label: 'Rise' }, { contract_type: 'PUT', label: 'Fall' },
 { contract_type: 'ONETOUCH', label: 'Touch' }, { contract_type: 'NOTOUCH', label: 'No Touch' },
 { contract_type: 'RANGE', label: 'Stays Between' }, { contract_type: 'UPORDOWN', label: 'Ends Between' },
];
type ContractOption = { contract_type: string; label: string };
type AiFinding = { title: string; detail: string; score: string; note: string };
const DigitMatchesScanner = () => {
 const { connectionStatus } = useApiBase();
 const [symbol, setSymbol] = useState('R_10');
 const [windowSize, setWindowSize] = useState(100);
 const [ticks, setTicks] = useState<DigitTick[]>([]);
 const [status, setStatus] = useState<'STOPPED'|'CONNECTING'|'SCANNING'|'PAUSED'|'ERROR'>('STOPPED');
 const [error, setError] = useState('');
 const [revision, setRevision] = useState(0);
 const [scanRequested, setScanRequested] = useState(false);
 const [contractOptions, setContractOptions] = useState<ContractOption[]>(FALLBACK_CONTRACTS);
 const [contractType, setContractType] = useState('DIGITMATCH');
 const [barrier, setBarrier] = useState(4);
 const [finding, setFinding] = useState<AiFinding | null>(null);
 const [analysedAt, setAnalysedAt] = useState<number | null>(null);
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
  if (connectionStatus !== 'opened' || !api_base.api) return;
  let active = true;
  const load = async () => {
   try {
    const response = await (api_base.api!.send({contracts_for:symbol}) as unknown as Promise<any>);
    if (!active || response?.error) return;
    const available = response?.contracts_for?.available;
    if (!Array.isArray(available)) return;
    const mapped = available.map((item: any) => ({
     contract_type: String(item.contract_type || ''),
     label: String(item.contract_display || item.contract_category_display || item.contract_type || ''),
    })).filter((item: ContractOption) => item.contract_type);
    if (mapped.length) {
     setContractOptions(mapped);
     setContractType(current => mapped.some(item => item.contract_type === current) ? current : mapped[0].contract_type);
    }
   } catch { /* keep the explicit supported-contract fallback list */ }
  };
  void load();
  return () => { active = false; };
 }, [symbol, connectionStatus]);

 useEffect(() => {
  if (!scanRequested) return;
  if (connectionStatus !== 'opened' || !api_base.api) { setStatus('ERROR'); setError('Deriv public market-data connection is not ready. Wait for the feed to connect, then retry.'); return; }
  let mounted = true;
  let subscriptionId: string | undefined;
  const appendTick = (tick: any) => {
   if (!mounted || !tick || tick.symbol !== symbol || tick.quote === undefined || tick.epoch === undefined) return;
   try {
    const precision = Number(api_base.pip_sizes?.[symbol] ?? 2);
    const quote = quoteWithPrecision(tick.quote, precision);
    const digit = extractLastDigit(quote);
    const epoch = Number(tick.epoch);
    setTicks(previous => {
     if (!Number.isFinite(epoch) || (previous.length && epoch <= previous[previous.length - 1].epoch)) return previous;
     return [...previous, {symbol, quote, digit, epoch}].slice(-windowSize);
    });
   } catch { /* malformed source tick is rejected */ }
  };
  const sub = api_base.api.onMessage().subscribe((raw: any) => {
   if (raw?.msg_type === 'tick') appendTick(raw.tick);
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
    // Some Deriv API clients return the first subscribed tick in the send response as well as on the message stream.
    if (live?.tick) appendTick(live.tick);
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
 }, [scanRequested, symbol, windowSize, connectionStatus]);

 const start = () => { setTicks([]); setFinding(null); setAnalysedAt(null); setError(''); setStatus('CONNECTING'); setScanRequested(true); };
 const pause = () => { setScanRequested(false); setStatus('PAUSED'); };
 const stop = () => { setScanRequested(false); setStatus('STOPPED'); setTicks([]); setError(''); setFinding(null); setAnalysedAt(null); };
 const runAiAnalysis = () => {
  setFinding(null);
  const minimum = Math.min(100, windowSize);
  if (report.sampleSize < minimum) {
   setFinding({title:'WAIT · more market data needed',detail:`Received ${report.sampleSize} of ${minimum} required ticks.`,score:'—',note:'The scanner will not invent a signal from an incomplete sample.'});
   setAnalysedAt(Date.now());
   return;
  }
  const type = contractType.toUpperCase();
  const ranked = [...report.digits].sort((a,b)=>b.count-a.count);
  const least = [...report.digits].sort((a,b)=>a.count-b.count);
  const pct = (n:number,d:number) => d ? `${(n/d*100).toFixed(1)}%` : '0.0%';
  if (type === 'DIGITMATCH' || type === 'DIGITDIFF') {
   const candidate = type === 'DIGITMATCH' ? ranked[0] : least[0];
   setFinding({title:`${type === 'DIGITMATCH' ? 'MATCHES' : 'DIFFERS'} · strongest observed digit ${candidate.digit}`,detail:`Digit ${candidate.digit} appeared ${candidate.count} times in ${report.sampleSize} ticks.`,score:pct(candidate.count,report.sampleSize),note:'Historical frequency only; this is not a calibrated next-tick probability.'});
  } else if (type === 'DIGITEVEN' || type === 'DIGITODD') {
   const count = type === 'DIGITEVEN' ? report.even : report.odd;
   const label = type === 'DIGITEVEN' ? 'EVEN' : 'ODD';
   setFinding({title:`${label} · observed sample share`,detail:`${count} of ${report.sampleSize} last digits were ${label.toLowerCase()}.`,score:pct(count,report.sampleSize),note:'No next-tick guarantee. The Even/Odd Parity Bot handles execution separately.'});
  } else if (type === 'DIGITOVER' || type === 'DIGITUNDER') {
   const eligible = report.digits.filter(d => type === 'DIGITOVER' ? d.digit > barrier : d.digit < barrier);
   const count = eligible.reduce((sum,d)=>sum+d.count,0);
   const candidate = [...eligible].sort((a,b)=>b.count-a.count)[0];
   setFinding({title:`${type === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${barrier} · observed share`,detail:`${count} of ${report.sampleSize} ticks met this barrier.${candidate ? ` Most observed qualifying digit: ${candidate.digit}.` : ''}`,score:pct(count,report.sampleSize),note:'Barrier uses strict greater-than / less-than. Historical share is not a forecast probability.'});
  } else if (type === 'CALL' || type === 'PUT' || type === 'UPORDOWN') {
   const moves = ticks.slice(1).map((tick,index)=>Number(tick.quote)-Number(ticks[index].quote));
   const rises = moves.filter(move=>move>0).length;
   const falls = moves.filter(move=>move<0).length;
   const count = type === 'CALL' ? rises : falls;
   const total = rises + falls;
   setFinding({title:`${type === 'CALL' ? 'RISE' : type === 'PUT' ? 'FALL' : 'DIRECTIONAL'} · recent movement`,detail:`${rises} rising and ${falls} falling quote changes in the sample.`,score:pct(count,total),note:'Direction contracts are evaluated from quote movement, not from a predicted last digit.'});
  } else {
   setFinding({title:'CONTRACT TYPE IDENTIFIED · analysis limited',detail:`${contractOptions.find(item=>item.contract_type===contractType)?.label || contractType} is available for this market.`,score:'—',note:'A contract-specific analyzer and its required barrier/parameter validation must be implemented before this type can be scored. No fabricated signal is shown.'});
  }
  setAnalysedAt(Date.now());
 };
 const candidates = (kind:'MATCHES'|'DIFFERS') => kind === 'MATCHES' ? report.matches : report.differs;
 return <div className='dmi-scanner'>
  <div className='dmi-topline'><span className='dmi-kicker'>INDEPENDENT MARKET INTELLIGENCE</span><span className={`dmi-status dmi-status--${status.toLowerCase()}`}>● {status}</span></div>
  <div className='dmi-controls'>
   <label>Deriv market<select value={symbol} onChange={e=>{setScanRequested(false);setStatus('STOPPED');setSymbol(e.target.value);setTicks([]);setFinding(null);}}>{marketOptions.map((m:any)=><option key={m.symbol} value={m.symbol}>{m.display_name || m.symbol}</option>)}</select></label>
   <label>Contract type<select value={contractType} onChange={e=>{setContractType(e.target.value);setFinding(null);}}>{contractOptions.map(item=><option key={item.contract_type} value={item.contract_type}>{item.label} · {item.contract_type}</option>)}</select></label>
   {(contractType==='DIGITOVER'||contractType==='DIGITUNDER') && <label>Barrier digit<select value={barrier} onChange={e=>setBarrier(Number(e.target.value))}>{Array.from({length:10},(_,digit)=><option key={digit} value={digit}>{digit}</option>)}</select></label>}
   <label>Analysis window<select value={windowSize} onChange={e=>{setWindowSize(Number(e.target.value));setFinding(null);}}>{WINDOWS.map(n=><option key={n} value={n}>{n} ticks</option>)}</select></label>
   <div className='dmi-actions'><button onClick={start} disabled={status==='SCANNING'}>Start scanner</button><button onClick={pause} disabled={status!=='SCANNING'}>Pause</button><button onClick={stop}>Stop</button></div>
  </div>
  <div className='dmi-ai-action'><button type='button' onClick={runAiAnalysis}>✦ AI Analyse selected contract</button><span>Uses the validated sample for the selected market and contract</span></div>
  {finding && <section className='dmi-ai-result' aria-live='polite'><div><small>AI ANALYSIS RESULT {analysedAt ? `· ${new Date(analysedAt).toLocaleTimeString()}` : ''}</small><h3>{finding.title}</h3><p>{finding.detail}</p></div><strong>{finding.score}</strong><p>{finding.note}</p></section>}
  {error && <p className='dmi-error' role='alert'>{error}</p>}
  <div className='dmi-kpis'><div><small>VALID TICKS</small><b>{report.sampleSize}</b></div><div><small>EVEN OBSERVED</small><b>{report.even}</b></div><div><small>ODD OBSERVED</small><b>{report.odd}</b></div><div><small>DATA QUALITY</small><b>{report.sampleSize ? 'ORDERED' : 'WAITING'}</b></div></div>
  <div className='dmi-digit-heading'><div><h3>Live last-digit intelligence · 0–9</h3><p>Latest digit: <strong>{ticks.length ? ticks[ticks.length-1].digit : '—'}</strong> · strongest observed digit: <strong>{report.sampleSize ? [...report.digits].sort((a,b)=>b.count-a.count)[0].digit : '—'}</strong></p></div><span>{report.sampleSize} validated ticks</span></div>
  <div className='dmi-digits'>{report.digits.map(d=>{const aboveBaseline=d.frequency>=0.1;return <div key={d.digit} className={`dmi-digit-card ${aboveBaseline?'is-above':'is-below'}`}><b className='dmi-digit-circle'>{d.digit}</b><span>{d.count} hits</span><strong>{(d.frequency*100).toFixed(1)}%</strong><i><em style={{width:`${Math.max(0,Math.min(100,d.frequency*1000))}%`}} /></i><small>{aboveBaseline?'Above 10% sample baseline':'Below 10% sample baseline'}</small></div>})}</div>
  <div className='dmi-candidate-grid'>{(['MATCHES','DIFFERS'] as const).map(kind=><section key={kind}><h3>{kind} candidate review</h3>{candidates(kind).sort((a,b)=>b.score-a.score).slice(0,5).map(c=><div className='dmi-candidate' key={c.digit}><strong>Digit {c.digit}</strong><span>{(c.observedRate*100).toFixed(1)}% observed</span><b>{c.status}</b></div>)}</section>)}</div>
  <div className='dmi-layers'><h3>20-stage scanner pipeline</h3><div>{report.layers.map((layer,i)=><span key={layer.name} className={layer.status==='PASS'?'is-pass':''}>{String(i+1).padStart(2,'0')} · {layer.name} <b>{layer.status}</b></span>)}</div></div>
  <p className='dmi-disclaimer'>AI Analyse is an evidence summary of observed ticks, not a proven next-tick probability model. Contract types are discovered from Deriv when available. Scanner mode is analysis-only and never purchases a contract.</p>
 </div>;
};
export default DigitMatchesScanner;
