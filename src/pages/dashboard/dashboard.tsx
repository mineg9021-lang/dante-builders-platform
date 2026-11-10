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
import './dante-landing.scss';

type BotDefinition = { id: BotStrategyId; title: string; contract: string; description: string; group: string; icon: string };
const BOT_LIBRARY: BotDefinition[] = [
 { id:'RISE',title:'Rise Bot',contract:'CALL',description:'Trades upward price movement after bounded momentum and direction checks.',group:'Directional',icon:'↗' },
 { id:'FALL',title:'Fall Bot',contract:'PUT',description:'Trades downward price movement after bounded momentum and direction checks.',group:'Directional',icon:'↘' },
 { id:'ONLY_UP',title:'Only Up Bot',contract:'RUNHIGH',description:'Requires consecutive strictly rising ticks before entry.',group:'Consecutive movement',icon:'↑' },
 { id:'ONLY_DOWN',title:'Only Down Bot',contract:'RUNLOW',description:'Requires consecutive strictly falling ticks before entry.',group:'Consecutive movement',icon:'↓' },
 { id:'ASIAN_UP',title:'Asian Up AI Bot',contract:'ASIANU',description:'Combines directional momentum with current-price versus sample-average confirmation.',group:'Asian',icon:'⌃' },
 { id:'ASIAN_DOWN',title:'Asian Down AI Bot',contract:'ASIAND',description:'Combines downward momentum with current-price versus sample-average confirmation.',group:'Asian',icon:'⌄' },
 { id:'DIGIT_MATCH',title:'Digit Matches Bot',contract:'DIGITMATCH',description:'Ranks observed final-digit frequency and validates a prediction barrier.',group:'Digit',icon:'=' },
 { id:'DIGIT_DIFFERS',title:'Digit Differs Bot',contract:'DIGITDIFF',description:'Selects a low-frequency digit candidate and validates its concentration.',group:'Digit',icon:'≠' },
 { id:'DIGIT_OVER',title:'Digit Over Bot',contract:'DIGITOVER',description:'Evaluates final-digit observations against an over barrier.',group:'Digit',icon:'>' },
 { id:'DIGIT_UNDER',title:'Digit Under Bot',contract:'DIGITUNDER',description:'Evaluates final-digit observations against an under barrier.',group:'Digit',icon:'<' },
 { id:'EVEN',title:'Even Bot',contract:'DIGITEVEN',description:'Uses bounded parity frequency and split-window checks before entry.',group:'Parity',icon:'E' },
 { id:'ODD',title:'Odd Bot',contract:'DIGITODD',description:'Uses bounded parity frequency and split-window checks before entry.',group:'Parity',icon:'O' },
];
const BOT_IDS = getImplementedStrategyIds();
const BOT_BY_ID = new Map(BOT_LIBRARY.map(bot => [bot.id, bot]));
type TradeRow = { id:string; contractId:number; contractType:string; symbol:string; status:'OPEN'|'WON'|'LOST'|'VOID'; profit?:number; time:number };

const DashboardComponent = () => {
 const { client } = useStore();
 const { isAuthorized, connectionStatus, authData } = useApiBase();
 const [selectedBot,setSelectedBot] = useState<BotStrategyId>('RISE');
 const [mode,setMode] = useState<'demo'|'live'>('demo');
 const [stake,setStake] = useState('0.35');
 const [stopLoss,setStopLoss] = useState('5');
 const [takeProfit,setTakeProfit] = useState('5');
 const [maxTrades,setMaxTrades] = useState('10');
 const [duration,setDuration] = useState('5');
 const [runLength,setRunLength] = useState('5');
 const [barrier,setBarrier] = useState('4');
 const [liveConfirmed,setLiveConfirmed] = useState(false);
 const [runtimeStatus,setRuntimeStatus] = useState<RuntimeStatus>('STOPPED');
 const [runtimeMessage,setRuntimeMessage] = useState('Connect your Deriv account, configure the bot and press Start.');
 const [decision,setDecision] = useState<StrategyDecisionResult|null>(null);
 const [trades,setTrades] = useState<TradeRow[]>([]);
 const [sessionPnl,setSessionPnl] = useState(0);
 const [wins,setWins] = useState(0);
 const [losses,setLosses] = useState(0);
 const [loginError,setLoginError] = useState('');
 const runtimeRef = useRef<RuntimeHandle|null>(null);
 const liveConfirmedRef = useRef(false);
 const pnlRef = useRef(0);
 const tradeCountRef = useRef(0);
 const bot = BOT_BY_ID.get(selectedBot) || BOT_LIBRARY[0];
 const isDerivConnected = isAuthorized && connectionStatus === 'opened';
 const accountId = authData?.loginid || '';
 const accountBalance = Number(authData?.balance || 0);
 const currency = authData?.currency || '';
 const accountType = authData?.is_virtual ? 'DEMO ACCOUNT' : authData ? 'REAL ACCOUNT' : 'NOT CONNECTED';
 const winRate = wins + losses ? Math.round(wins/(wins+losses)*100) : 0;

 useEffect(() => () => { runtimeRef.current?.stop(); runtimeRef.current=null; }, []);
 useEffect(() => { if(mode!=='live'){setLiveConfirmed(false);liveConfirmedRef.current=false;} },[mode]);

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
 const stopBot = () => { runtimeRef.current?.stop(); runtimeRef.current=null; setRuntimeStatus('STOPPED'); setRuntimeMessage('Bot stopped. No new purchases will be initiated.'); };
 const startBot = async () => {
  if(runtimeRef.current){setRuntimeMessage('This bot already has an active runtime. Stop it before starting another session.');return;}
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
    strategy:{id:selectedBot,minSample:12,maxSample:40,runLength:Number(runLength),barrier:Number(barrier),duration:ticks,durationUnit:'t'},
    currency,risk:baseRisk,getRiskContext:buildRisk,
    onStatus:(status,message)=>{setRuntimeStatus(status);setRuntimeMessage(message);},
    onDecision:result=>setDecision(result),
    onPurchased:purchase=>setTrades(previous=>[{id:String(purchase.contractId),contractId:purchase.contractId,contractType:purchase.contractType,symbol:purchase.symbol,status:'OPEN',time:Date.now()},...previous].slice(0,30)),
    onSettled:result=>{
     pnlRef.current+=result.profit;tradeCountRef.current+=1;setSessionPnl(pnlRef.current);
     if(result.settlement==='WON')setWins(value=>value+1);
     if(result.settlement==='LOST')setLosses(value=>value+1);
     setTrades(previous=>previous.map(row=>row.contractId===result.contractId?{...row,status:result.settlement,profit:result.profit}:row));
     if(pnlRef.current<=-sl||pnlRef.current>=tp||tradeCountRef.current>=limit){runtimeRef.current?.stop();runtimeRef.current=null;setRuntimeStatus('STOPPED');setRuntimeMessage('Session limit reached. The bot has stopped and settlement is recorded.');}
    },
    onError:error=>setRuntimeMessage(error.message),
   });
   runtimeRef.current=handle;
  }catch(error){setRuntimeStatus('STOPPED');setRuntimeMessage(error instanceof Error?error.message:'The Deriv bot runtime could not start.');}
 };
 const selectBot=(id:BotStrategyId)=>{runtimeRef.current?.stop();runtimeRef.current=null;setRuntimeStatus('STOPPED');setSelectedBot(id);setDecision(null);setRuntimeMessage('Bot selected. Configure the controls below and press Start.');};
 const currentRows=useMemo(()=>trades.slice(0,10),[trades]);

 return <main className="dante-platform">
  <header className="dante-topbar">
   <button className="dante-brand" type="button" onClick={()=>selectBot('RISE')}><span className="dante-brand-mark">DB</span><span><strong>DANTE BUILDERS</strong><small>AI TRADING PLATFORM</small></span></button>
   <nav aria-label="Platform navigation"><button className="active" type="button" onClick={()=>document.getElementById('bot-library')?.scrollIntoView({behavior:'smooth'})}>Bot library</button><button type="button" onClick={()=>document.getElementById('bot-terminal')?.scrollIntoView({behavior:'smooth'})}>Workspace</button><button type="button" onClick={()=>document.getElementById('trade-journal')?.scrollIntoView({behavior:'smooth'})}>Trade journal</button></nav>
   <div className={isDerivConnected?'dante-connection is-connected':'dante-connection'}><span className="connection-dot"/>{isDerivConnected?'DERIV CONNECTED':'DERIV NOT CONNECTED'}</div>
  </header>
  <section className="dante-system-hero">
   <div className="dante-system-copy"><span className="dante-eyebrow">DANTE AI CORE · MULTI-BOT RUNTIME</span><h1>One platform.<br/><em>Specialist trading engines.</em></h1><p>Connect your Deriv account once. Select a specialist bot, configure risk and let its contract-specific runtime handle live market data, validation, proposal, purchase and settlement.</p><div className="dante-system-tags"><span>DERIV OAUTH</span><span>LIVE MARKET DATA</span><span>RISK-GATED EXECUTION</span></div></div>
   <div className="dante-system-portrait"><img src="/assets/images/dante-bot-portraits.webp" alt="Dante Builders robotic assistant"/><div className="portrait-glow"/><div className="portrait-caption"><span>AI CORE</span><strong>Specialist runtime</strong></div></div>
   <div className="dante-system-status"><div><span>PLATFORM SESSION</span><strong>{client.is_logged_in?'SIGNED IN':'ACCOUNT REQUIRED'}</strong></div><div><span>DERIV ACCOUNT</span><strong>{isDerivConnected?accountId:'Awaiting OAuth'}</strong></div><div><span>BOT STATUS</span><strong>{runtimeStatus.replaceAll('_',' ')}</strong></div></div>
  </section>
  <section className="dante-library" id="bot-library">
   <div className="dante-section-heading"><div><span className="dante-eyebrow">SPECIALIST BOT LIBRARY</span><h2>Select your trading engine</h2></div><p>{BOT_IDS.length} strategy adapters registered in this release</p></div>
   <div className="dante-bot-grid">{BOT_LIBRARY.map(item=><button key={item.id} type="button" className={selectedBot===item.id?'dante-bot-card selected':'dante-bot-card'} onClick={()=>selectBot(item.id)}><span className="bot-card-icon">{item.icon}</span><span className="bot-card-group">{item.group} · {item.contract}</span><strong>{item.title}</strong><small>{item.description}</small><span className="bot-card-action">{selectedBot===item.id?'SELECTED':'OPEN WORKSPACE'} <b>↗</b></span></button>)}</div>
  </section>
  <section className="dante-terminal" id="bot-terminal">
   <div className="dante-terminal-purple">
    <div className="terminal-identity"><img src="/assets/images/dante-bot-portraits.webp" alt=""/><div><span className="dante-eyebrow">{bot.group.toUpperCase()} STRATEGY WORKSPACE</span><h2>{bot.title}</h2><p>Deriv contract: <strong>{bot.contract}</strong> · Market stream: <strong>AUTO · 13 VOLATILITY MARKETS</strong></p></div></div>
    <div className="terminal-account-strip"><div><span>DERIV ACCOUNT</span><strong>{isDerivConnected?accountId:'Not connected'}</strong></div><div><span>ACCOUNT TYPE</span><strong>{accountType}</strong></div><div><span>LIVE BALANCE</span><strong>{isDerivConnected?Number(authData?.balance||0).toFixed(2)+' '+currency:'—'}</strong></div><button type="button" className="terminal-connect" onClick={connectDeriv}>{isDerivConnected?'RECONNECT DERIV':'CONNECT DERIV'}</button></div>
    {loginError&&<p className="dante-error" role="alert">{loginError}</p>}
    <div className="terminal-state-row"><div><span>RUNTIME</span><strong>{runtimeStatus.replaceAll('_',' ')}</strong></div><div><span>STRATEGY DECISION</span><strong>{decision?.decision||'WAITING'}</strong></div><div><span>LAST EVIDENCE</span><strong>{decision?decision.evidenceScore+'%':'—'}</strong></div></div>
    <div className="terminal-actions"><button type="button" className="terminal-start" onClick={startBot} disabled={runtimeStatus==='STARTING'||runtimeStatus==='RUNNING'||runtimeStatus==='EXECUTING'}>START BOT</button><button type="button" className="terminal-stop" onClick={stopBot} disabled={runtimeStatus==='STOPPED'}>STOP BOT</button><span className="terminal-mode">{mode.toUpperCase()} EXECUTION</span></div>
   </div>
   <div className="dante-white-dashboard">
    <div className="dante-section-heading compact"><div><span className="dante-eyebrow">BOT CONTROL CENTRE</span><h3>Execution settings</h3></div><span className="dante-status-pill">{runtimeStatus.replaceAll('_',' ')}</span></div>
    <p className="runtime-message">{runtimeMessage}</p>
    <div className="dante-control-grid">
     <label>Account mode<select value={mode} onChange={event=>setMode(event.target.value as 'demo'|'live')}><option value="demo">Demo account</option><option value="live">Real account</option></select></label>
     <label>Stake ({currency||'account currency'})<input type="number" min="0.01" step="0.01" value={stake} onChange={event=>setStake(event.target.value)}/></label>
     <label>Stop loss<input type="number" min="0.01" step="0.01" value={stopLoss} onChange={event=>setStopLoss(event.target.value)}/></label>
     <label>Take profit<input type="number" min="0.01" step="0.01" value={takeProfit} onChange={event=>setTakeProfit(event.target.value)}/></label>
     <label>Maximum trades<input type="number" min="1" step="1" value={maxTrades} onChange={event=>setMaxTrades(event.target.value)}/></label>
     <label>Contract duration (ticks)<input type="number" min="1" max="100" step="1" value={duration} onChange={event=>setDuration(event.target.value)}/></label>
     {(selectedBot==='ONLY_UP'||selectedBot==='ONLY_DOWN')&&<label>Consecutive ticks<input type="number" min="3" max="30" step="1" value={runLength} onChange={event=>setRunLength(event.target.value)}/></label>}
     {(selectedBot==='DIGIT_OVER'||selectedBot==='DIGIT_UNDER')&&<label>Digit barrier<input type="number" min="0" max="8" step="1" value={barrier} onChange={event=>setBarrier(event.target.value)}/></label>}
    </div>
    <div className="dante-risk-note"><strong>Risk protection:</strong> fixed stake · 2% balance exposure cap · session stop loss · session take profit · trade-count limit · no martingale · no automatic purchase retries.</div>
    <div className="dante-metric-grid"><div><span>SESSION P/L</span><strong className={sessionPnl>=0?'metric-positive':'metric-negative'}>{sessionPnl.toFixed(2)} {currency}</strong></div><div><span>SETTLED WINS</span><strong>{wins}</strong></div><div><span>SETTLED LOSSES</span><strong>{losses}</strong></div><div><span>WIN RATE</span><strong>{winRate}%</strong></div></div>
    <div className="dante-decision-panel"><div><span>STRATEGY DECISION</span><strong>{decision?.decision||'WAIT'}</strong></div><p>{decision?.reason||'The strategy will report a decision after it receives a sufficient sample of fresh Deriv ticks.'}</p><small>{decision?decision.sampleSize+' source ticks · '+decision.contractType+' · '+decision.evidenceScore+'% evidence score':'No market data is fabricated or displayed before a real Deriv stream is connected.'}</small></div>
   </div>
  </section>
  <section className="dante-journal" id="trade-journal">
   <div className="dante-section-heading compact"><div><span className="dante-eyebrow">VERIFIED CONTRACT EVENTS</span><h3>Session trade journal</h3></div><span>{trades.length} events</span></div>
   {currentRows.length?<div className="dante-table-wrap"><table><thead><tr><th>Contract</th><th>Market</th><th>Contract ID</th><th>Status</th><th>Profit / loss</th></tr></thead><tbody>{currentRows.map(row=><tr key={row.id}><td>{row.contractType}</td><td>{row.symbol}</td><td>{row.contractId}</td><td><span className={'trade-status '+row.status.toLowerCase()}>{row.status}</span></td><td>{row.profit===undefined?'Pending settlement':row.profit.toFixed(2)+' '+currency}</td></tr>)}</tbody></table></div>:<div className="dante-empty-journal">No Deriv contracts have been purchased in this session.</div>}
  </section>
  <footer className="dante-footer"><span>DANTE BUILDERS</span><span>Deriv OAuth · Contract-aware execution · User-controlled risk</span></footer>
 </main>;
};

const PlatformDashboard = () => <DanteAccountGate><DashboardComponent/></DanteAccountGate>;
export default PlatformDashboard;
