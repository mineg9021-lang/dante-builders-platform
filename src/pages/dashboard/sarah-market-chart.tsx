import React, { useEffect, useMemo, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { DANTE_VOLATILITY_SYMBOLS } from './market-universe';
import './sarah-market-chart.scss';

type Candle = { epoch:number; open:number; high:number; low:number; close:number };

export default function SarahMarketChart({ connected }:{connected:boolean}) {
 const [symbol,setSymbol]=useState('R_100');
 const [granularity,setGranularity]=useState(60);
 const [candles,setCandles]=useState<Candle[]>([]);
 const [status,setStatus]=useState('WAITING FOR DERIV CONNECTION');
 const [lastPrice,setLastPrice]=useState<number|null>(null);
 const precision=Number(api_base.pip_sizes?.[symbol]??2);
 useEffect(()=>{
  const api=api_base.api as any;
  if(!connected||!api?.send||!api?.onMessage){setCandles([]);setLastPrice(null);setStatus('CONNECT DERIV TO LOAD LIVE CANDLES');return;}
  let active=true; let subscriptionId:string|undefined;
  const subscription=api.onMessage().subscribe(({data}:any)=>{
   if(!active||!data)return;
   if(data.echo_req?.ticks_history&&data.echo_req.ticks_history!==symbol)return;
   if(data.error){setStatus(String(data.error.message||'MARKET DATA ERROR'));return;}
   if(Array.isArray(data.candles)){
    const rows=data.candles.map((v:any)=>({epoch:Number(v.epoch),open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)})).filter((v:Candle)=>Object.values(v).every(Number.isFinite));
    if(rows.length){setCandles(rows.slice(-90));setLastPrice(rows[rows.length-1].close);setStatus('LIVE MARKET FEED');}
   }
   if(data.ohlc){const v=data.ohlc;const next={epoch:Number(v.epoch),open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)};if(Object.values(next).every(Number.isFinite)){setCandles(old=>{const copy=[...old];const i=copy.findIndex(x=>x.epoch===next.epoch);if(i>=0)copy[i]=next;else copy.push(next);return copy.slice(-90);});setLastPrice(next.close);setStatus('LIVE MARKET FEED');}}
   if(data.subscription?.id)subscriptionId=String(data.subscription.id);
  });
  setCandles([]);setStatus('CONNECTING TO DERIV');
  api.send({ticks_history:symbol,end:'latest',count:90,style:'candles',granularity,subscribe:1}).then((response:any)=>{
   if(!active)return;if(response?.error){setStatus(String(response.error.message||'MARKET DATA ERROR'));return;}
   if(response?.subscription?.id)subscriptionId=String(response.subscription.id);
   if(Array.isArray(response?.candles)){const rows=response.candles.map((v:any)=>({epoch:Number(v.epoch),open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)})).filter((v:Candle)=>Object.values(v).every(Number.isFinite));setCandles(rows.slice(-90));if(rows.length)setLastPrice(rows[rows.length-1].close);setStatus(rows.length?'LIVE MARKET FEED':'NO CANDLES RECEIVED');}
  }).catch((e:any)=>{if(active)setStatus(e?.message||'MARKET DATA UNAVAILABLE');});
  return ()=>{active=false;subscription.unsubscribe();if(subscriptionId&&api.forget)api.forget(subscriptionId);};
 },[connected,symbol,granularity]);
 const bounds=useMemo(()=>{const all=candles.flatMap(c=>[c.high,c.low]);const min=all.length?Math.min(...all):0;const max=all.length?Math.max(...all):1;return {min,max,span:max-min||Math.max(Math.abs(max)*0.0001,0.000001)};},[candles]);
 const y=(price:number)=>190-((price-bounds.min)/bounds.span)*165;
 const step=900/Math.max(candles.length,1);
 return <section className="sarah-market-card" id="market-chart">
  <header className="sarah-market-head"><div><span className="sarah-eyebrow">SARAH AI · LIVE MARKET INTELLIGENCE</span><h2>Market workstation</h2><p>Deriv market data, rendered in Dante Builders</p></div><span className="sarah-feed-status"><i/>{status}</span></header>
  <div className="sarah-market-tools"><label>MARKET<select value={symbol} onChange={e=>setSymbol(e.target.value)}>{DANTE_VOLATILITY_SYMBOLS.map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label><label>TIMEFRAME<select value={granularity} onChange={e=>setGranularity(Number(e.target.value))}><option value={60}>1 minute</option><option value={120}>2 minutes</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option></select></label><div className="sarah-price"><span>LAST PRICE</span><strong>{lastPrice===null?'—':lastPrice.toFixed(precision)}</strong></div></div>
  <div className="sarah-chart-area">{candles.length?<svg viewBox="0 0 940 220" preserveAspectRatio="none" role="img" aria-label={symbol+' live candlestick chart'}>{[0,1,2,3,4].map(i=><g key={i}><line x1="0" x2="940" y1={20+i*42} y2={20+i*42} stroke="#e9e5f4" strokeDasharray="3 5"/><text x="935" y={16+i*42} textAnchor="end" fill="#958aa9" fontSize="9">{(bounds.max-bounds.span*i/4).toFixed(precision)}</text></g>)}{candles.map((c,i)=>{const x=8+i*step;const up=c.close>=c.open;const top=y(Math.max(c.open,c.close));const bottom=y(Math.min(c.open,c.close));return <g key={c.epoch}><line x1={x+step*.45} x2={x+step*.45} y1={y(c.high)} y2={y(c.low)} stroke={up?'#16a879':'#df5572'} strokeWidth="1.3"/><rect x={x+step*.12} y={top} width={Math.max(2,step*.66)} height={Math.max(1,bottom-top)} rx="1" fill={up?'#16a879':'#df5572'}/></g>;})}</svg>:<div className="sarah-chart-empty"><strong>{connected?'Waiting for live candles':'Connect Deriv to view live markets'}</strong><small>No sample prices are fabricated.</small></div>}</div>
  <footer className="sarah-chart-foot"><span>{symbol} · {granularity/60}m candles</span><span>{candles.length} candles</span><span>DERIV LIVE API</span></footer>
 </section>;
}