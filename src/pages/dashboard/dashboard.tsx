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
import SarahMarketChart from './sarah-market-chart';
import './dante-landing.scss';

type RobotId = BotStrategyId | 'BULK';
type RobotDefinition = { id: RobotId; title: string; contract: string; description: string; group: string; icon: string };
const ROBOT_LIBRARY: RobotDefinition[] = [
 { id:'RISE',title:'Rise Robot',contract:'CALL',description:'Trades upward price movement after bounded momentum and direction checks.',group:'Directional',icon:'↗' },
 { id:'FALL',title:'Fall Robot',contract:'PUT',description:'Trades downward price movement after bounded momentum and direction checks.',group:'Directional',icon:'↘' },
 { id:'ONLY_UP',title:'Only Up Robot',contract:'RUNHIGH',description:'Requires consecutive strictly rising ticks before entry.',group:'Consecutive movement',icon:'↑' },
 { id:'ONLY_DOWN',title:'Only Down Robot',contract:'RUNLOW',description:'Requires consecutive strictly falling ticks before entry.',group:'Consecutive movement',icon:'↓' },
 { id:'ASIAN_UP',title:'Asian Up AI Robot',contract:'ASIANU',description:'Combines directional momentum with current-price versus sample-average confirmation.',group:'Asian',icon:'⌃' },
 { id:'ASIAN_DOWN',title:'Asian Down AI Robot',contract:'ASIAND',description:'Combines downward momentum with current-price versus sample-average confirmation.',group:'Asian',icon:'⌄' },
 { id:'DIGIT_MATCH',title:'Digit Matches Robot',contract:'DIGITMATCH',description:'Ranks observed final-digit frequency and validates a prediction barrier.',group:'Digit',icon:'=' },
 { id:'DIGIT_DIFFERS',title:'Digit Differs Robot',contract:'DIGITDIFF',description:'Selects a low-frequency digit candidate and validates its concentration.',group:'Digit',icon:'≠' },
 { id:'DIGIT_OVER',title:'Digit Over Robot',contract:'DIGITOVER',description:'Evaluates final-digit observations against a user-selected over barrier.',group:'Digit',icon:'>' },
 { id:'OVER_TWO',title:'Over 2 Robot',contract:'DIGITOVER · BARRIER 2',description:'A dedicated Over 2 specialist. Only digits 3–9 qualify; digits 0–2 never satisfy its entry rule.',group:'Digit specialist',icon:'2' },
 { id:'DIGIT_UNDER',title:'Digit Under Robot',contract:'DIGITUNDER',description:'Evaluates final-digit observations against an under barrier.',group:'Digit',icon:'<' },
 { id:'EVEN',title:'Even Robot',contract:'DIGITEVEN',description:'Uses bounded parity frequency and split-window checks before entry.',group:'Parity',icon:'E' },
 { id:'ODD',title:'Odd Robot',contract:'DIGITODD',description:'Uses bounded parity frequency and split-window checks before entry.',group:'Parity',icon:'O' },
 { id:'BULK',title:'Bulk Robot',contract:'MULTI-CONTRACT',description:'Analyses the selected contract strategy, waits for its strongest qualifying signal, then dispatches a risk-capped batch together.',group:'Batch execution',icon:'B' },
];
const ROBOT_BY_ID = new Map(ROBOT_LIBRARY.map(bot => [bot.id, bot]));
type TradeRow = { id:string; contractId:number; contractType:string; symbol:string; status:'OPEN'|'WON'|'LOST'|'VOID'; profit?:number; time:number };

const DashboardComponent = () => {
 const { client } = useStore();
 const { isAuthorized, connectionStatus, authData, accountList, activeLoginid } = useApiBase();
 const [selectedBot,setSelectedBot] = useState<RobotId>('RISE');
 const [bulkStrategy,setBulkStrategy] = useState<BotStrategyId>('DIGIT_OVER');
 const [bulkRuns,setBulkRuns] = useState('10');
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
 const [runtimeMessage,setRuntimeMessage] = useState('Connect your Deriv account, configure the Robot and press Start.');
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
 const bot = ROBOT_BY_ID.get(selectedBot) || ROBOT_LIBRARY[0];
 const activeStrategy: BotStrategyId = selectedBot === 'BULK' ? bulkStrategy : selectedBot;
 const configuredBulkRuns = selectedBot === 'BULK' ? Number(bulkRuns) : 1;
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
  liveTradingConfirmed:mode==='live'&&liveConfirmedRef.current,stake:Number(stake),balance:accountBalance,
  maxStake:Number(stake),maxStakePercent:2,sessionPnl:pnlRef.current,
  stopLoss:Number(stopLoss),takeProfit:Number(takeProfit),
  tradesThisSession:tradeCountRef.current,maxTradesPerSession:Number(maxTrades),
 });
 const stopBot = () => { startAttemptRef.current += 1; runtimeRef.current?.stop(); runtimeRef.current=null; setRuntimeStatus('STOPPED'); setRuntimeMessage('Robot stopped. No new purchases will be initiated.'); };
 const startBot = async () => {
  const attempt = ++startAttemptRef.current;
  if(runtimeRef.current){setRuntimeMessage('This robot already has an active runtime. Stop it before starting another session.');return;}
  if(!isDerivConnected||!api_base.api){setRuntimeMessage('Deriv is not authorised. Connect your Deriv account before starting.');return;}
  if(mode==='live'){const accepted=window.confirm('You selected a REAL Deriv account. Trades will use real funds. Confirm live execution for this session.');if(!accepted)return;liveConfirmedRef.current=true;setLiveConfirmed(true);}
  if(!currency){setRuntimeMessage('Deriv did not provide an account currency. Refresh the account connection.');return;}
  const stakeValue=Number(stake),sl=Number(stopLoss),tp=Number(takeProfit),limit=Number(maxTrades),ticks=Number(duration),batchRuns=Number(bulkRuns);
  if(![stakeValue,sl,tp,limit,ticks].every(Number.isFinite)||stakeValue<=0||sl<=0||tp<=0||!Number.isInteger(limit)||limit<1||!Number.isInteger(ticks)||ticks<1||(selectedBot==='BULK'&&(!Number.isInteger(batchRuns)||batchRuns<2||batchRuns>20||limit<batchRuns))){setRuntimeMessage('Check stake, stop loss, take profit, trade limit and duration values.');return;}
  const symbols=[...DANTE_VOLATILITY_SYMBOLS];
  const precisionBySymbol=Object.fromEntries(symbols.map(symbol=>[symbol,Number(api_base.pip_sizes?.[symbol]??2)]));
  setDecision(null);setRuntimeStatus('STARTING');setRuntimeMessage('Checking live contract availability and opening the Deriv tick stream…');
  try{
   const baseRisk=buildRisk();
   const handle=await startStrategyRuntime({
    api:api_base.api as unknown as DerivTradingApi,symbols,precisionBySymbol,
    strategy:{id:activeStrategy,minSample:12,maxSample:40,runLength:Number(runLength),barrier:Number(barrier),duration:ticks,durationUnit:'t'},
    bulkRuns:configuredBulkRuns,
    currency,risk:baseRisk,getRiskContext:buildRisk,shouldContinue:()=>startAttemptRef.current===attempt,
    onStatus:(status,message)=>{
     setRuntimeStatus(status);setRuntimeMessage(message);
     if(runtimeStatusRef.current!==status){
      runtimeStatusRef.current=status;
      void appendDanteJournalEvent({botKey:selectedBot,derivAccountId:accountId,eventType:'RUNTIME_STATUS',eventData:{status,message}})
       .catch(()=>setJournalError('A runtime status could not be saved to the persistent journal.'));
     }
    },
    onDecision:result=>{
     setDecision(result);
     const decisionKey=[result.decision,result.reason,result.contractType].join(':');
     if(lastDecisionLogKeyRef.current!==decisionKey){
      lastDecisionLogKeyRef.current=decisionKey;
      void appendDanteJournalEvent({botKey:selectedBot,derivAccountId:accountId,eventType:'DECISION',eventData:{decision:result.decision,contractType:result.contractType,evidenceScore:result.evidenceScore,sampleSize:result.sampleSize,reason:result.reason}})
       .catch(()=>setJournalError('An analysis activity could not be saved to the platform journal.'));
     }
    },
    onPurchased:purchase=>{
     setTrades(previous=>[{id:String(purchase.contractId),contractId:purchase.contractId,contractType:purchase.contractType,symbol:purchase.symbol,status:'OPEN' as const,time:Date.now()},...previous].slice(0,50));
     void appendDanteJournalEvent({botKey:selectedBot,derivAccountId:accountId,contractId:purchase.contractId,eventType:'PURCHASED',eventData:{contractType:purchase.contractType,symbol:purchase.symbol,buyPrice:purchase.buyPrice}})
      .catch(()=>setJournalError('A purchased contract could not be saved to the persistent journal.'));
    },
    onSettled:result=>{
     pnlRef.current+=result.profit;tradeCountRef.current+=1;setSessionPnl(pnlRef.current);
     if(result.settlement==='WON')setWins(value=>value+1);
     if(result.settlement==='LOST')setLosses(value=>value+1);
     setTrades(previous=>previous.map(row=>row.contractId===result.contractId?{...row,status:result.settlement,profit:result.profit}:row));
     void appendDanteJournalEvent({botKey:selectedBot,derivAccountId:accountId,contractId:result.contractId,eventType:'SETTLED',eventData:{settlement:result.settlement,profit:result.profit,buyPrice:result.buyPrice,settledAt:result.settledAt}})
      .catch(()=>setJournalError('A contract settlement could not be saved to the persistent journal.'));
     if(pnlRef.current<=-sl||pnlRef.current>=tp||tradeCountRef.current>=limit){runtimeRef.current?.stop();runtimeRef.current=null;setRuntimeStatus('STOPPED');setRuntimeMessage('Session limit reached. The bot has stopped and settlement is recorded.');}
    },
    onError:error=>{
    setRuntimeMessage(error.message);
    void appendDanteJournalEvent({botKey:selectedBot,derivAccountId:accountId,eventType:'RUNTIME_STATUS',eventData:{status:'PAUSED_ERROR',message:error.message}})
     .catch(()=>setJournalError('The runtime error could not be saved to the persistent journal.'));
   },
   });
   if(startAttemptRef.current!==attempt){handle.stop();return;}
   runtimeRef.current=handle;
  }catch(error){setRuntimeStatus('STOPPED');setRuntimeMessage(error instanceof Error?error.message:'The Deriv bot runtime could not start.');}
 };
 const selectBot=(id:RobotId)=>{startAttemptRef.current += 1;runtimeRef.current?.stop();runtimeRef.current=null;setRuntimeStatus('STOPPED');setSelectedBot(id);setDecision(null);setRuntimeMessage('Robot selected. Configure the controls below and press Start.');};
 const currentRows=useMemo(()=>trades.slice(0,10),[trades]);

 return <main className="dante-platform">
  <header className="dante-topbar">
   <button className="dante-brand" type="button" onClick={()=>selectBot('RISE')}><span className="dante-brand-mark">DB</span><span><strong>DANTE BUILDERS</strong><small>AI TRADING PLATFORM</small></span></button>
   <nav aria-label="Platform navigation"><button className="active" type="button" onClick={()=>document.getElementById('bot-library')?.scrollIntoView({behavior:'smooth'})}>Robot library</button><button type="button" onClick={()=>document.getElementById('bot-terminal')?.scrollIntoView({behavior:'smooth'})}>Workspace</button><button type="button" onClick={()=>document.getElementById('trade-journal')?.scrollIntoView({behavior:'smooth'})}>Trade journal</button><button type="button" onClick={()=>document.getElementById('platform-activity')?.scrollIntoView({behavior:'smooth'})}>Platform activity</button></nav>
   <div className={isDerivConnected?'dante-connection is-connected':'dante-connection'}><span className="connection-dot"/>{isDerivConnected?'DERIV CONNECTED':'DERIV NOT CONNECTED'}</div>
  </header>
  <section className="dante-system-hero">
   <div className="dante-system-copy"><span className="dante-eyebrow">DANTE BUILDERS · SPECIALIST ROBOT COLLECTION</span><h1>One platform.<br/><em>Specialist trading engines.</em></h1><p>Connect your Deriv account once. Select a specialist Robot, configure risk and let its contract-specific runtime handle live market data, validation, proposal, purchase and settlement.</p><div className="dante-system-tags"><span>DERIV OAUTH</span><span>LIVE MARKET DATA</span><span>RISK-GATED EXECUTION</span></div></div>
   <div className="dante-system-portrait"><img src="/assets/images/dante-bot-portraits.webp" alt="Dante Builders robotic assistant"/><div className="portrait-glow"/><div className="portrait-caption"><span>ROBOT ASSISTANT</span><strong>Ready when you are</strong></div></div>
   <div className="dante-system-status"><div><span>PLATFORM SESSION</span><strong>{client.is_logged_in?'SIGNED IN':'ACCOUNT REQUIRED'}</strong></div><div><span>DERIV ACCOUNT</span><strong>{isDerivConnected?accountId:'Awaiting OAuth'}</strong></div><div><span>ROBOT STATUS</span><strong>{runtimeStatus.replace(/_/g,' ')}</strong></div></div>
  </section>
  <SarahMarketChart connected={isDerivConnected}/>
  <section className="dante-library dante-robot-library" id="bot-library">
   <div className="dante-section-heading"><div><span className="dante-eyebrow">MEET YOUR SPECIALIST ROBOTS</span><h2>Choose your robot</h2></div><p>{ROBOT_LIBRARY.length} specialist workspaces</p></div>
   <div className="dante-bot-grid dante-robot-grid">{ROBOT_LIBRARY.map((robot,index)=>{
    const active=selectedBot===robot.id;
    return <button key={robot.id} type="button" className={active?'dante-bot-card dante-robot-card selected':'dante-bot-card dante-robot-card'} onClick={()=>selectBot(robot.id)} aria-pressed={active}>
     <span role="img" aria-label={robot.title+' logo'} className={'robot-logo-frame robot-logo-'+robot.id.toLowerCase()} style={{backgroundImage:'url(/assets/images/robot-fleet.svg)',backgroundSize:'400% 400%',backgroundPosition:(index%4)*100/3+'% '+Math.floor(index/4)*100/3+'%'}}/>
     <span className="bot-card-group">{robot.group.toUpperCase()}</span><strong>{robot.title}</strong><small>{robot.description}</small>
     <span className="robot-contract-tag">{robot.contract}</span>
     <span className="bot-card-action">{active?'ACTIVE ROBOT':'SELECT ROBOT'} <b>↗</b></span>
    </button>;
   })}</div>
  </section>
  <section className="dante-terminal" id="bot-terminal">
   <div className="dante-terminal-purple">
    <div className="terminal-identity"><img src="/assets/images/dante-bot-portraits.webp" alt=""/><div><span className="dante-eyebrow">{bot.group.toUpperCase()} ROBOT WORKSPACE</span><h2>{bot.title}</h2><p>Deriv contract: <strong>{bot.contract}</strong> · Market stream: <strong>AUTO · 13 VOLATILITY MARKETS</strong></p></div></div>
    <div className="terminal-account-strip"><div><span>DERIV ACCOUNT</span><strong>{isDerivConnected?accountId:'Not connected'}</strong></div><div><span>ACCOUNT TYPE</span><strong>{accountType}</strong></div><div><span>LIVE BALANCE</span><strong>{isDerivConnected?(liveBalance===null?'Loading balance…':liveBalance.toFixed(2)+' '+currency):'—'}</strong></div><div className="terminal-connect-actions"><button type="button" className="terminal-connect" onClick={connectDeriv}>{isDerivConnected?'RECONNECT DERIV':'CONNECT DERIV'}</button><a className="terminal-open-deriv" href="https://app.deriv.com/" target="_blank" rel="noopener noreferrer">OPEN DERIV PLATFORM ↗</a><a className="terminal-open-deriv" href="https://developers.deriv.com/" target="_blank" rel="noopener noreferrer">API TOKEN MANAGER ↗</a></div></div>
    {loginError&&<p className="dante-error" role="alert">{loginError}</p>}
    <div className="terminal-state-row"><div><span>RUNTIME</span><strong>{runtimeStatus.replace(/_/g,' ')}</strong></div><div><span>STRATEGY DECISION</span><strong>{decision?.decision||'WAITING'}</strong></div><div><span>LAST EVIDENCE</span><strong>{decision?decision.evidenceScore+'%':'—'}</strong></div></div>
    <div className="terminal-actions"><button type="button" className="terminal-start" onClick={startBot} disabled={runtimeStatus==='STARTING'||runtimeStatus==='RUNNING'||runtimeStatus==='EXECUTING'}>START ROBOT</button><button type="button" className="terminal-stop" onClick={stopBot} disabled={runtimeStatus==='STOPPED'}>STOP ROBOT</button><span className="terminal-mode">{mode.toUpperCase()} EXECUTION</span></div>
   </div>
   <div className="dante-white-dashboard">
    <div className="dante-section-heading compact"><div><span className="dante-eyebrow">ROBOT CONTROL CENTRE</span><h3>Execution settings</h3></div><span className="dante-status-pill">{runtimeStatus.replace(/_/g,' ')}</span></div>
    <p className="runtime-message">{runtimeMessage}</p>
    <div className="dante-control-grid">
     <label>Deriv account<select value={activeLoginid} onChange={event=>switchDerivAccount(event.target.value)} disabled={!isDerivConnected || runtimeStatus!=='STOPPED'}>{accountList.map(account=><option key={account.loginid} value={account.loginid}>{account.is_virtual ? 'Demo' : 'Real'} · {account.loginid} · {account.currency}</option>)}</select></label>
     <label>Stake ({currency||'account currency'})<input type="number" min="0.01" step="0.01" value={stake} onChange={event=>setStake(event.target.value)}/></label>
     <label>Stop loss<input type="number" min="0.01" step="0.01" value={stopLoss} onChange={event=>setStopLoss(event.target.value)}/></label>
     <label>Take profit<input type="number" min="0.01" step="0.01" value={takeProfit} onChange={event=>setTakeProfit(event.target.value)}/></label>
     <label>Maximum trades<input type="number" min="1" step="1" value={maxTrades} onChange={event=>setMaxTrades(event.target.value)}/></label>
     <label>Contract duration (ticks)<input type="number" min="1" max="100" step="1" value={duration} onChange={event=>setDuration(event.target.value)}/></label>
     {selectedBot==='BULK'&&<><label>Contract strategy<select value={bulkStrategy} onChange={event=>setBulkStrategy(event.target.value as BotStrategyId)} disabled={runtimeStatus!=='STOPPED'}>{getImplementedStrategyIds().map(id=><option key={id} value={id}>{id.replace(/_/g,' ')}</option>)}</select></label><label>Bulk purchases per signal<input type='number' min='2' max='20' step='1' value={bulkRuns} onChange={event=>setBulkRuns(event.target.value)}/></label></>}
     {(selectedBot==='ONLY_UP'||selectedBot==='ONLY_DOWN')&&<label>Consecutive ticks<input type="number" min="3" max="30" step="1" value={runLength} onChange={event=>setRunLength(event.target.value)}/></label>}
     {(selectedBot==='DIGIT_OVER'||selectedBot==='DIGIT_UNDER'||(selectedBot==='BULK'&&(bulkStrategy==='DIGIT_OVER'||bulkStrategy==='DIGIT_UNDER')))&&<label>Digit barrier<input type="number" min="0" max="8" step="1" value={barrier} onChange={event=>setBarrier(event.target.value)}/></label>}
    </div>
    <div className="dante-risk-note"><strong>Risk protection:</strong> fixed stake · 2% balance exposure cap · session stop loss · session take profit · trade-count limit · no martingale · no automatic purchase retries.{selectedBot==='BULK'?' Bulk batches must pass the 2% aggregate exposure cap; Stop prevents future batches, but already-submitted purchases may still settle.':''}</div>
    <div className="dante-metric-grid"><div><span>SESSION P/L</span><strong className={sessionPnl>=0?'metric-positive':'metric-negative'}>{sessionPnl.toFixed(2)} {currency}</strong></div><div><span>SETTLED WINS</span><strong>{wins}</strong></div><div><span>SETTLED LOSSES</span><strong>{losses}</strong></div><div><span>WIN RATE</span><strong>{winRate}%</strong></div></div>
    <div className="dante-decision-panel"><div><span>STRATEGY DECISION</span><strong>{decision?.decision||'WAIT'}</strong></div><p>{decision?.reason||'The strategy will report a decision after it receives a sufficient sample of fresh Deriv ticks.'}</p><small>{decision?decision.sampleSize+' source ticks · '+decision.contractType+' · '+decision.evidenceScore+'% evidence score':'No market data is fabricated or displayed before a real Deriv stream is connected.'}</small></div>
    {(selectedBot==='EVEN'||selectedBot==='ODD')&&decision?.strategyMetrics&&<div className="parity-analysis-panel"><div className="parity-analysis-heading"><strong>{selectedBot==='EVEN'?'Even':'Odd'} parity analysis</strong><span>{decision.sampleSize} observed ticks</span></div><div className="parity-analysis-grid"><div><span>EVEN DIGITS</span><strong>{decision.strategyMetrics.evenCount}</strong></div><div><span>ODD DIGITS</span><strong>{decision.strategyMetrics.oddCount}</strong></div><div><span>FULL WINDOW</span><strong>{Math.round(decision.strategyMetrics.fullRate*100)}%</strong></div><div><span>FIRST HALF</span><strong>{Math.round(decision.strategyMetrics.firstRate*100)}%</strong></div><div><span>SECOND HALF</span><strong>{Math.round(decision.strategyMetrics.secondRate*100)}%</strong></div></div><p>These figures describe the observed sample only. They are not calibrated probabilities or a prediction guarantee.</p></div>}

   </div>
  </section>
  <section className="dante-journal" id="trade-journal">
   <div className="dante-section-heading compact"><div><span className="dante-eyebrow">VERIFIED CONTRACT EVENTS</span><h3>Trade journal</h3></div><span>{trades.length} contracts · persistent</span></div>
   {journalError&&<p className="runtime-message" role="status">{journalError}</p>}
   {currentRows.length?<div className="dante-table-wrap"><table><thead><tr><th>Contract</th><th>Market</th><th>Contract ID</th><th>Status</th><th>Profit / loss</th></tr></thead><tbody>{currentRows.map(row=><tr key={row.id}><td>{row.contractType}</td><td>{row.symbol}</td><td>{row.contractId}</td><td><span className={'trade-status '+row.status.toLowerCase()}>{row.status}</span></td><td>{row.profit===undefined?'Pending settlement':row.profit.toFixed(2)+' '+currency}</td></tr>)}</tbody></table></div>:<div className="dante-empty-journal">No robot has purchased a Deriv contract in this session.</div>}
  </section>
  <PlatformActivity />
  <footer className="dante-footer"><span>DANTE BUILDERS</span><span>Deriv OAuth · Contract-aware execution · User-controlled risk</span></footer>
 </main>;
};

const PlatformDashboard = () => <DanteAccountGate><DashboardComponent/></DanteAccountGate>;
export default PlatformDashboard;
