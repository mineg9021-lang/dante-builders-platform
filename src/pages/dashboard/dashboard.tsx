import React, { useEffect, useMemo, useRef, useState } from 'react';
import DanteAccountGate from '@/components/account-gate';
import { generateOAuthURL } from '@/components/shared';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { startStrategyRuntime, type RuntimeHandle, type RuntimeStatus } from '@/trading-engine/runtime';
import type { DerivTradingApi, ExecutionRiskContext } from '@/trading-engine/execution';
import { getImplementedStrategyIds, type BotStrategyId, type StrategyDecisionResult } from '@/trading-engine/strategy-adapters';
import { DANTE_VOLATILITY_SYMBOLS } from './market-universe';
import { appendDanteJournalEvent, loadDanteJournal } from '@/services/dante-journal.service';
import PlatformActivity from './platform-activity';
import ChartWrapper from '@/pages/chart/chart-wrapper';
import './dante-landing.scss';

const SELECTABLE_STRATEGIES: BotStrategyId[] = getImplementedStrategyIds().filter(id => id !== 'OVER_TWO');
const STRATEGY_LABELS: Record<BotStrategyId, string> = {
 RISE:'Rise', FALL:'Fall', ONLY_UP:'Only Up', ONLY_DOWN:'Only Down', ASIAN_UP:'Asian Up', ASIAN_DOWN:'Asian Down',
 DIGIT_MATCH:'Matches', DIGIT_DIFFERS:'Differs', DIGIT_OVER:'Over', DIGIT_UNDER:'Under', EVEN:'Even', ODD:'Odd', OVER_TWO:'Over 2',
};
type TradeRow = { id:string; contractId:number; contractType:string; symbol:string; status:'OPEN'|'WON'|'LOST'|'VOID'; profit?:number; time:number };

const DashboardComponent = () => {
 const { client } = useStore();
 const { isAuthorized, connectionStatus, authData, accountList, activeLoginid } = useApiBase();
 const [selectedStrategy,setSelectedStrategy] = useState<BotStrategyId>('RISE');
 const [martingaleEnabled,setMartingaleEnabled] = useState(false);
 const currentStakeRef = useRef<number|null>(null);
 const mode: 'demo'|'live' = authData?.is_virtual ? 'demo' : 'live';
 const [stake,setStake] = useState('0.35');
 const [stopLoss,setStopLoss] = useState('5');
 const [takeProfit,setTakeProfit] = useState('5');
 const [maxTrades,setMaxTrades] = useState('10');
 const [duration,setDuration] = useState('5');
 const [runLength,setRunLength] = useState('5');
 const [barrier,setBarrier] = useState('4');
 const [liveConfirmed,setLiveConfirmed] = useState(false);
 const [runtimeStatus,setRuntimeStatus] = useState<RuntimeStatus>('STOPPED');
 const [runtimeMessage,setRuntimeMessage] = useState('Connect Deriv, choose a contract and press Start to begin Sara AI analysis.');
 const [decision,setDecision] = useState<StrategyDecisionResult|null>(null);
 const [trades,setTrades] = useState<TradeRow[]>([]);
 const [sessionPnl,setSessionPnl] = useState(0);
 const [wins,setWins] = useState(0);
 const [losses,setLosses] = useState(0);
 const [loginError,setLoginError] = useState('');
 const [journalError,setJournalError] = useState('');
 const [liveBalance,setLiveBalance] = useState<number|null>(null);
 const [liveCurrency,setLiveCurrency] = useState('');
 const runtimeStatusRef = useRef<RuntimeStatus>('STOPPED');
 const runtimeRef = useRef<RuntimeHandle|null>(null);
 const startAttemptRef = useRef(0);
 const liveConfirmedRef = useRef(false);
 const pnlRef = useRef(0);
 const lastDecisionLogKeyRef = useRef('');
 const tradeCountRef = useRef(0);
 const isDerivConnected = isAuthorized && connectionStatus === 'opened';
 const accountId = authData?.loginid || '';
 const accountBalance = liveBalance ?? 0;
 const currency = authData?.currency || liveCurrency || '';
 const accountType = authData?.is_virtual ? 'DEMO ACCOUNT' : authData ? 'REAL ACCOUNT' : 'NOT CONNECTED';
 const winRate = wins + losses ? Math.round(wins/(wins+losses)*100) : 0;

 useEffect(() => {
  if (!isDerivConnected || !accountId) { setLiveBalance(null); setLiveCurrency(''); return; }
  const initialBalance = Number(authData?.balance);
  setLiveBalance(Number.isFinite(initialBalance) ? initialBalance : null);
  setLiveCurrency(authData?.currency || '');
  const api = api_base.api;
  if (!api?.onMessage) return;
  const subscription = api.onMessage().subscribe((message:any) => {
   if (message?.msg_type !== 'balance' || !message?.balance) return;
   const update = message.balance;
   if (update.loginid && update.loginid !== accountId) return;
   const nextBalance = Number(update.balance);
   if (Number.isFinite(nextBalance)) setLiveBalance(nextBalance);
   if (typeof update.currency === 'string' && update.currency) setLiveCurrency(update.currency);
  });
  return () => subscription.unsubscribe();
 }, [isDerivConnected, accountId, authData?.balance, authData?.currency, connectionStatus]);

 useEffect(() => {
  let active=true;
  void loadDanteJournal().then(events=>{
   if(!active)return;
   const rows=new Map<number,TradeRow>();
   for(const event of [...events].reverse()){
    if(!event.contract_id)continue;
    const data=event.event_data||{};
    const contractId=Number(event.contract_id);
    if(!Number.isSafeInteger(contractId)||contractId<=0)continue;
    if(event.event_type==='PURCHASED'){
     rows.set(contractId,{id:String(contractId),contractId,contractType:String(data.contractType||'UNKNOWN'),symbol:String(data.symbol||'—'),status:'OPEN',time:new Date(event.created_at).getTime()});
    }else if(event.event_type==='SETTLED'){
     const previous=rows.get(contractId);
     const settlement=data.settlement;
     if(previous&&['WON','LOST','VOID'].includes(String(settlement))){
      rows.set(contractId,{...previous,status:settlement as TradeRow['status'],profit:Number(data.profit),time:new Date(event.created_at).getTime()});
     }
    }
   }
   setTrades([...rows.values()].sort((a,b)=>b.time-a.time).slice(0,50));
  }).catch(()=>{if(active)setJournalError('Persistent journal is temporarily unavailable; this session will still show local events.');});
  return ()=>{active=false;startAttemptRef.current += 1;runtimeRef.current?.stop();runtimeRef.current=null;};
 }, []);
 useEffect(() => { setLiveConfirmed(false); liveConfirmedRef.current=false; },[mode, activeLoginid]);
 const switchDerivAccount = (loginid: string) => {
  if (!loginid || loginid === activeLoginid) return;
  stopBot();
  setRuntimeMessage('Switching Deriv account. Waiting for the new authenticated connection…');
  localStorage.setItem('active_loginid', loginid);
  client.checkAndRegenerateWebSocket();
 };

 const connectDeriv = async () => {
  setLoginError('');
  try { const url=await generateOAuthURL(); if(!url) throw new Error('Deriv sign-in could not be started. Check the registered OAuth application settings.'); window.location.assign(url); }
  catch(error){ setLoginError(error instanceof Error?error.message:'Unable to start Deriv sign-in.'); }
 };
 const buildRisk = (): Omit<ExecutionRiskContext,'strategyDecision'|'lastTickEpoch'> => ({
  mode,authorized:isDerivConnected,isVirtual:Boolean(authData?.is_virtual),
  liveTradingConfirmed:mode==='live'&&liveConfirmedRef.current,stake:currentStakeRef.current??Number(stake),balance:accountBalance,
  maxStake:currentStakeRef.current??Number(stake),maxStakePercent:2,sessionPnl:pnlRef.current,
  stopLoss:Number(stopLoss),takeProfit:Number(takeProfit),
  tradesThisSession:tradeCountRef.current,maxTradesPerSession:Number(maxTrades),
 });
 const stopBot = () => { startAttemptRef.current += 1; runtimeRef.current?.stop(); runtimeRef.current=null; currentStakeRef.current=null; setRuntimeStatus('STOPPED'); setRuntimeMessage('Sara AI stopped. No new purchases will be initiated.'); };
 const startBot = async () => {
  const attempt = ++startAttemptRef.current;
  if(runtimeRef.current){setRuntimeMessage('Sara AI already has an active session. Stop it before starting another one.');return;}
  if(!isDerivConnected||!api_base.api){setRuntimeMessage('Deriv is not authorised. Connect your Deriv account before starting.');return;}
  if(mode==='live'){const accepted=window.confirm('You selected a REAL Deriv account. Trades will use real funds. Confirm live execution for this session.');if(!accepted)return;liveConfirmedRef.current=true;setLiveConfirmed(true);}
  if(!currency){setRuntimeMessage('Deriv did not provide an account currency. Refresh the account connection.');return;}
  const stakeValue=Number(stake),sl=Number(stopLoss),tp=Number(takeProfit),limit=Number(maxTrades),ticks=Number(duration);
  if(![stakeValue,sl,tp,limit,ticks].every(Number.isFinite)||stakeValue<=0||sl<=0||tp<=0||!Number.isInteger(limit)||limit<1||!Number.isInteger(ticks)||ticks<1){setRuntimeMessage('Check stake, stop loss, take profit, trade limit and duration values.');return;}
  const symbols=[...DANTE_VOLATILITY_SYMBOLS];
  const precisionBySymbol=Object.fromEntries(symbols.map(symbol=>[symbol,Number(api_base.pip_sizes?.[symbol]??2)]));
  setDecision(null);setRuntimeStatus('STARTING');setRuntimeMessage('Checking live contract availability and opening the Deriv tick stream…');
  try{
   const baseRisk=buildRisk();
   const handle=await startStrategyRuntime({
    api:api_base.api as unknown as DerivTradingApi,symbols,precisionBySymbol,
    strategy:{id:selectedStrategy,minSample:12,maxSample:40,runLength:Number(runLength),barrier:Number(barrier),duration:ticks,durationUnit:'t'},
    currency,risk:baseRisk,getRiskContext:buildRisk,shouldContinue:()=>startAttemptRef.current===attempt,
    onStatus:(status,message)=>{
     setRuntimeStatus(status);setRuntimeMessage(message);
     if(runtimeStatusRef.current!==status){
      runtimeStatusRef.current=status;
      void appendDanteJournalEvent({botKey:selectedStrategy,derivAccountId:accountId,eventType:'RUNTIME_STATUS',eventData:{status,message}})
       .catch(()=>setJournalError('A runtime status could not be saved to the persistent journal.'));
     }
    },
    onDecision:result=>{
     setDecision(result);
     const decisionKey=[result.decision,result.reason,result.contractType].join(':');
     if(lastDecisionLogKeyRef.current!==decisionKey){
      lastDecisionLogKeyRef.current=decisionKey;
      void appendDanteJournalEvent({botKey:selectedStrategy,derivAccountId:accountId,eventType:'DECISION',eventData:{decision:result.decision,contractType:result.contractType,evidenceScore:result.evidenceScore,sampleSize:result.sampleSize,reason:result.reason}})
       .catch(()=>setJournalError('An analysis activity could not be saved to the platform journal.'));
     }
    },
    onPurchased:purchase=>{
     setTrades(previous=>[{id:String(purchase.contractId),contractId:purchase.contractId,contractType:purchase.contractType,symbol:purchase.symbol,status:'OPEN' as const,time:Date.now()},...previous].slice(0,50));
     void appendDanteJournalEvent({botKey:selectedStrategy,derivAccountId:accountId,contractId:purchase.contractId,eventType:'PURCHASED',eventData:{contractType:purchase.contractType,symbol:purchase.symbol,buyPrice:purchase.buyPrice}})
      .catch(()=>setJournalError('A purchased contract could not be saved to the persistent journal.'));
    },
    onSettled:result=>{
     pnlRef.current+=result.profit;tradeCountRef.current+=1;setSessionPnl(pnlRef.current);
     if(martingaleEnabled&&result.settlement==='LOST') currentStakeRef.current=Number(((currentStakeRef.current??Number(stake))*1.5).toFixed(2));
     else currentStakeRef.current=Number(stake);
     if(result.settlement==='WON')setWins(value=>value+1);
     if(result.settlement==='LOST')setLosses(value=>value+1);
     setTrades(previous=>previous.map(row=>row.contractId===result.contractId?{...row,status:result.settlement,profit:result.profit}:row));
     void appendDanteJournalEvent({botKey:selectedStrategy,derivAccountId:accountId,contractId:result.contractId,eventType:'SETTLED',eventData:{settlement:result.settlement,profit:result.profit,buyPrice:result.buyPrice,settledAt:result.settledAt}})
      .catch(()=>setJournalError('A contract settlement could not be saved to the persistent journal.'));
     if(pnlRef.current<=-sl||pnlRef.current>=tp||tradeCountRef.current>=limit){runtimeRef.current?.stop();runtimeRef.current=null;currentStakeRef.current=null;setRuntimeStatus('STOPPED');setRuntimeMessage('Session limit reached. Sara AI has stopped and settlement is recorded.');}
    },
    onError:error=>{
    setRuntimeMessage(error.message);
    void appendDanteJournalEvent({botKey:selectedStrategy,derivAccountId:accountId,eventType:'RUNTIME_STATUS',eventData:{status:'PAUSED_ERROR',message:error.message}})
     .catch(()=>setJournalError('The runtime error could not be saved to the persistent journal.'));
   },
   });
   if(startAttemptRef.current!==attempt){handle.stop();return;}
   runtimeRef.current=handle;
  }catch(error){setRuntimeStatus('STOPPED');setRuntimeMessage(error instanceof Error?error.message:'The Deriv bot runtime could not start.');}
 };
 const selectStrategy=(id:BotStrategyId)=>{startAttemptRef.current += 1;runtimeRef.current?.stop();runtimeRef.current=null;setRuntimeStatus('STOPPED');setSelectedStrategy(id);setDecision(null);currentStakeRef.current=null;setRuntimeMessage('Contract type selected. Sara AI will analyse the live Deriv market when you press Start.');};
 const currentRows=useMemo(()=>trades.slice(0,10),[trades]);

 return <main className="dante-platform">
  <header className="dante-topbar">
   <button className="dante-brand" type="button" onClick={()=>selectStrategy('RISE')}><span className="dante-brand-mark">DB</span><span><strong>DANTE BUILDERS</strong><small>AI TRADING PLATFORM</small></span></button>
   <nav aria-label="Platform navigation"><button className="active" type="button" onClick={()=>document.getElementById('bot-terminal')?.scrollIntoView({behavior:'smooth'})}>Sara AI</button><button type="button" onClick={()=>document.getElementById('bot-terminal')?.scrollIntoView({behavior:'smooth'})}>Workspace</button><button type="button" onClick={()=>document.getElementById('trade-journal')?.scrollIntoView({behavior:'smooth'})}>Trade journal</button><button type="button" onClick={()=>document.getElementById('platform-activity')?.scrollIntoView({behavior:'smooth'})}>Platform activity</button></nav>
   <div className={isDerivConnected?'dante-connection is-connected':'dante-connection'}><span className="connection-dot"/>{isDerivConnected?'DERIV CONNECTED':'DERIV NOT CONNECTED'}</div>
  </header>
  <section className="dante-system-hero">
   <div className="dante-system-copy"><span className="dante-eyebrow">DANTE BUILDERS · SARA AI ANALYSIS</span><h1>One chart.<br/><em>One intelligent assistant.</em></h1><p>Connect your Deriv account, choose a Deriv contract type and press Start. Sara AI analyses live market data and only requests a trade when the selected contract passes its checks.</p><div className="dante-system-tags"><span>DERIV OAUTH</span><span>LIVE MARKET DATA</span><span>RISK-GATED EXECUTION</span></div></div>
   <div className="dante-system-portrait"><img src="/assets/images/dante-bot-portraits.webp" alt="Sara AI robotic woman assistant"/><div className="portrait-glow"/><div className="portrait-caption"><span>AI CORE</span><strong>Sara AI assistant</strong></div></div>
   <div className="dante-system-status"><div><span>PLATFORM SESSION</span><strong>{client.is_logged_in?'SIGNED IN':'ACCOUNT REQUIRED'}</strong></div><div><span>DERIV ACCOUNT</span><strong>{isDerivConnected?accountId:'Awaiting OAuth'}</strong></div><div><span>SARA AI STATUS</span><strong>{runtimeStatus.replace(/_/g,' ')}</strong></div></div>
  </section>
  <section className="dante-native-chart" aria-label="Deriv live chart"><div className="dante-chart-heading"><span className="dante-eyebrow">DERIV SMARTCHARTS</span><strong>Live market chart</strong><small>Use the chart controls to change market and timeframe</small></div><ChartWrapper show_digits_stats={true}/></section>
  <section className="dante-terminal" id="bot-terminal">
   <div className="dante-terminal-purple">
    <div className="terminal-identity"><img src="/assets/images/dante-bot-portraits.webp" alt="Sara AI robotic woman portrait"/><div><span className="dante-eyebrow">SARA AI · CONTRACT ANALYSIS</span><h2>Sara AI Workstation</h2><p>Selected contract: <strong>{STRATEGY_LABELS[selectedStrategy]}</strong> · Live Deriv market feed</p></div></div>
    <div className="terminal-account-strip"><div><span>DERIV ACCOUNT</span><strong>{isDerivConnected?accountId:'Not connected'}</strong></div><div><span>ACCOUNT TYPE</span><strong>{accountType}</strong></div><div><span>LIVE BALANCE</span><strong>{isDerivConnected?(liveBalance===null?'Loading balance…':liveBalance.toFixed(2)+' '+currency):'—'}</strong></div><div className="terminal-connect-actions"><button type="button" className="terminal-connect" onClick={connectDeriv}>{isDerivConnected?'RECONNECT DERIV':'CONNECT DERIV'}</button><a className="terminal-open-deriv" href="https://app.deriv.com/" target="_blank" rel="noopener noreferrer">OPEN DERIV PLATFORM ↗</a><a className="terminal-open-deriv" href="https://developers.deriv.com/" target="_blank" rel="noopener noreferrer">API TOKEN MANAGER ↗</a></div></div>
    {loginError&&<p className="dante-error" role="alert">{loginError}</p>}
    <div className="terminal-state-row"><div><span>RUNTIME</span><strong>{runtimeStatus.replace(/_/g,' ')}</strong></div><div><span>STRATEGY DECISION</span><strong>{decision?.decision||'WAITING'}</strong></div><div><span>LAST EVIDENCE</span><strong>{decision?decision.evidenceScore+'%':'—'}</strong></div></div>
    <div className="terminal-actions"><button type="button" className="terminal-start" onClick={startBot} disabled={runtimeStatus==='STARTING'||runtimeStatus==='RUNNING'||runtimeStatus==='EXECUTING'} >START SARA AI</button><button type="button" className="terminal-stop" onClick={stopBot} disabled={runtimeStatus==='STOPPED'} >STOP</button><span className="terminal-mode">{mode.toUpperCase()} EXECUTION</span></div>
   </div>
   <div className="dante-white-dashboard">
    <div className="dante-section-heading compact"><div><span className="dante-eyebrow">SARA AI CONTROL CENTRE</span><h3>Execution settings</h3></div><span className="dante-status-pill">{runtimeStatus.replace(/_/g,' ')}</span></div>
    <p className="runtime-message">{runtimeMessage}</p>
    <div className="dante-control-grid">
     <label>Deriv account<select value={activeLoginid} onChange={event=>switchDerivAccount(event.target.value)} disabled={!isDerivConnected || runtimeStatus!=='STOPPED'}>{accountList.map(account=><option key={account.loginid} value={account.loginid}>{account.is_virtual ? 'Demo' : 'Real'} · {account.loginid} · {account.currency}</option>)}</select></label>
     <label>Stake ({currency||'account currency'})<input type="number" min="0.01" step="0.01" value={stake} onChange={event=>setStake(event.target.value)}/></label>
     <label>Stop loss<input type="number" min="0.01" step="0.01" value={stopLoss} onChange={event=>setStopLoss(event.target.value)}/></label>
     <label>Take profit<input type="number" min="0.01" step="0.01" value={takeProfit} onChange={event=>setTakeProfit(event.target.value)}/></label>
     <label>Contract type<select value={selectedStrategy} onChange={event=>selectStrategy(event.target.value as BotStrategyId)} disabled={runtimeStatus!=='STOPPED'}>{SELECTABLE_STRATEGIES.map(id=><option key={id} value={id}>{STRATEGY_LABELS[id]} · {id}</option>)}</select></label>
     <label>Maximum trades<input type="number" min="1" step="1" value={maxTrades} onChange={event=>setMaxTrades(event.target.value)} disabled={runtimeStatus!=='STOPPED'}/></label>
     <label>Contract duration (ticks)<input type="number" min="1" max="100" step="1" value={duration} onChange={event=>setDuration(event.target.value)} disabled={runtimeStatus!=='STOPPED'}/></label>
     {(selectedStrategy==='ONLY_UP'||selectedStrategy==='ONLY_DOWN')&&<label>Consecutive ticks<input type="number" min="3" max="30" step="1" value={runLength} onChange={event=>setRunLength(event.target.value)} disabled={runtimeStatus!=='STOPPED'}/></label>}
     {(selectedStrategy==='DIGIT_OVER'||selectedStrategy==='DIGIT_UNDER')&&<label>Digit barrier<input type="number" min="0" max="8" step="1" value={barrier} onChange={event=>setBarrier(event.target.value)} disabled={runtimeStatus!=='STOPPED'}/></label>}
     <label className="martingale-control">Martingale <span className="martingale-switch"><input type="checkbox" checked={martingaleEnabled} onChange={event=>{setMartingaleEnabled(event.target.checked);currentStakeRef.current=null;}} disabled={runtimeStatus!=='STOPPED'}/><b>{martingaleEnabled?'ON':'OFF'}</b></span><small>Multiplier 1.5× · after a loss only</small></label>
    </div>
    <div className="dante-risk-note"><strong>Risk protection:</strong> 2% balance exposure cap · session stop loss · session take profit · trade-count limit · no automatic purchase retries. Martingale is optional, user-controlled and only changes the next stake after a verified loss; the risk controller can block any stake above the exposure cap.</div>
    <div className="dante-metric-grid"><div><span>SESSION P/L</span><strong className={sessionPnl>=0?'metric-positive':'metric-negative'}>{sessionPnl.toFixed(2)} {currency}</strong></div><div><span>SETTLED WINS</span><strong>{wins}</strong></div><div><span>SETTLED LOSSES</span><strong>{losses}</strong></div><div><span>WIN RATE</span><strong>{winRate}%</strong></div></div>
    <div className="dante-decision-panel"><div><span>STRATEGY DECISION</span><strong>{decision?.decision||'WAIT'}</strong></div><p>{decision?.reason||'The strategy will report a decision after it receives a sufficient sample of fresh Deriv ticks.'}</p><small>{decision?decision.sampleSize+' source ticks · '+decision.contractType+' · '+decision.evidenceScore+'% evidence score':'No market data is fabricated or displayed before a real Deriv stream is connected.'}</small></div>
    {(selectedStrategy==='EVEN'||selectedStrategy==='ODD')&&decision?.strategyMetrics&&<div className="parity-analysis-panel"><div className="parity-analysis-heading"><strong>{selectedStrategy==='EVEN'?'Even':'Odd'} parity analysis</strong><span>{decision.sampleSize} observed ticks</span></div><div className="parity-analysis-grid"><div><span>EVEN DIGITS</span><strong>{decision.strategyMetrics.evenCount}</strong></div><div><span>ODD DIGITS</span><strong>{decision.strategyMetrics.oddCount}</strong></div><div><span>FULL WINDOW</span><strong>{Math.round(decision.strategyMetrics.fullRate*100)}%</strong></div><div><span>FIRST HALF</span><strong>{Math.round(decision.strategyMetrics.firstRate*100)}%</strong></div><div><span>SECOND HALF</span><strong>{Math.round(decision.strategyMetrics.secondRate*100)}%</strong></div></div><p>These figures describe the observed sample only. They are not calibrated probabilities or a prediction guarantee.</p></div>}

   </div>
  </section>
  <section className="dante-journal" id="trade-journal">
   <div className="dante-section-heading compact"><div><span className="dante-eyebrow">VERIFIED CONTRACT EVENTS</span><h3>Trade journal</h3></div><span>{trades.length} contracts · persistent</span></div>
   {journalError&&<p className="runtime-message" role="status">{journalError}</p>}
   {currentRows.length?<div className="dante-table-wrap"><table><thead><tr><th>Contract</th><th>Market</th><th>Contract ID</th><th>Status</th><th>Profit / loss</th></tr></thead><tbody>{currentRows.map(row=><tr key={row.id}><td>{row.contractType}</td><td>{row.symbol}</td><td>{row.contractId}</td><td><span className={'trade-status '+row.status.toLowerCase()}>{row.status}</span></td><td>{row.profit===undefined?'Pending settlement':row.profit.toFixed(2)+' '+currency}</td></tr>)}</tbody></table></div>:<div className="dante-empty-journal">No Deriv contracts have been purchased in this session.</div>}
  </section>
  <PlatformActivity />
  <footer className="dante-footer"><span>DANTE BUILDERS</span><span>Deriv OAuth · Contract-aware execution · User-controlled risk</span></footer>
 </main>;
};

const PlatformDashboard = () => <DanteAccountGate><DashboardComponent/></DanteAccountGate>;
export default PlatformDashboard;
