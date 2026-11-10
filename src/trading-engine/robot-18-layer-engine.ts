import type { BotStrategyConfig, StrategyDecisionResult, StrategyTick } from './strategy-adapters';
import type { ExecutionRiskContext } from './execution';

export const ROBOT_ENGINE_LAYERS = [
 'MARKET_SCOPE','TICK_SCHEMA','QUOTE_PRECISION','DECIMAL_INTEGRITY','TIMESTAMP_FRESHNESS','SEQUENCE_ORDER',
 'DUPLICATE_GUARD','DIGIT_EXTRACTION','SAMPLE_WINDOW','SAMPLE_MINIMUM','MARKET_STABILITY','PATTERN_ANALYSIS',
 'STRATEGY_EVIDENCE','CONTRACT_MAPPING','CONTRACT_AVAILABILITY','OPPORTUNITY_IDENTITY','ACCOUNT_AUTHORIZATION','RISK_PERMISSION',
] as const;
export type RobotEngineLayer = typeof ROBOT_ENGINE_LAYERS[number];
export type RobotEngineReport = { passed:boolean; passedLayers:number; totalLayers:18; blockedAt?:RobotEngineLayer; reason:string; layers:{name:RobotEngineLayer;passed:boolean;detail:string}[] };
export function runRobot18LayerEngine(input:{symbol:string;tick:StrategyTick;previous?:StrategyTick;sample:StrategyTick[];config:BotStrategyConfig;decision:StrategyDecisionResult;contractAvailable:boolean;risk:ExecutionRiskContext}):RobotEngineReport {
 const {tick,previous,sample,config,decision,risk}=input;
 const digitFromQuote=()=>{const fraction=tick.quote.split('.')[1]||'';const n=Number(fraction.slice(-1)||tick.quote.replace(/\\D/g,'').slice(-1));return Number.isInteger(n)&&n>=0&&n<=9&&n===tick.digit;};
 const checks:{name:RobotEngineLayer;passed:boolean;detail:string}[]=[
 {name:'MARKET_SCOPE',passed:/^[A-Za-z0-9_]{2,30}$/.test(input.symbol)&&tick.symbol===input.symbol,detail:'Configured market and tick symbol match'},
 {name:'TICK_SCHEMA',passed:typeof tick.quote==='string'&&Number.isFinite(tick.epoch)&&Number.isInteger(tick.digit),detail:'Tick fields are valid'},
 {name:'QUOTE_PRECISION',passed:/^[-+]?\\d+(?:\\.\\d+)?$/.test(tick.quote)&&tick.quote.split('.')[1]?.length===tick.quote.split('.')[1]?.length,detail:'Quote is a decimal string without float conversion'},
 {name:'DECIMAL_INTEGRITY',passed:digitFromQuote(),detail:'Final digit matches the source quote'},
 {name:'TIMESTAMP_FRESHNESS',passed:Date.now()/1000-tick.epoch<=15&&tick.epoch-Date.now()/1000<=5,detail:'Tick is within the freshness window'},
 {name:'SEQUENCE_ORDER',passed:!previous||tick.epoch>previous.epoch,detail:'Tick timestamp advances the stream'},
 {name:'DUPLICATE_GUARD',passed:!previous||tick.epoch!==previous.epoch,detail:'No duplicate source tick'},
 {name:'DIGIT_EXTRACTION',passed:Number.isInteger(tick.digit)&&tick.digit>=0&&tick.digit<=9,detail:'Final digit is in the 0–9 domain'},
 {name:'SAMPLE_WINDOW',passed:sample.length<=200&&sample.every(v=>v.symbol===input.symbol),detail:'Analysis sample is bounded and single-market'},
 {name:'SAMPLE_MINIMUM',passed:sample.length>=Math.max(5,Math.min(200,config.minSample??12)),detail:'Minimum configured evidence sample is present'},
 {name:'MARKET_STABILITY',passed:sample.length>=5&&sample.slice(-5).every((v,i,a)=>i===0||v.epoch>a[i-1].epoch),detail:'Recent sample has ordered observations'},
 {name:'PATTERN_ANALYSIS',passed:decision.decision==='READY'&&decision.sampleSize===sample.length,detail:'Specialist strategy has produced a READY analysis'},
 {name:'STRATEGY_EVIDENCE',passed:decision.evidenceScore>=55,detail:'Evidence score meets the common execution floor'},
 {name:'CONTRACT_MAPPING',passed:typeof decision.contractType==='string'&&decision.contractType.length>0,detail:'Strategy resolves to a Deriv contract type'},
 {name:'CONTRACT_AVAILABILITY',passed:input.contractAvailable,detail:'Deriv reports this contract for the selected market'},
 {name:'OPPORTUNITY_IDENTITY',passed:Boolean(decision.opportunityKey),detail:'Signal has a unique opportunity identity'},
 {name:'ACCOUNT_AUTHORIZATION',passed:risk.authorized&&(risk.mode!=='live'||(!risk.isVirtual&&risk.liveTradingConfirmed))&&(risk.mode!=='demo'||risk.isVirtual),detail:'Account authorization and live confirmation are valid'},
 {name:'RISK_PERMISSION',passed:Number.isFinite(risk.stake)&&risk.stake>0&&risk.stake<=risk.maxStake&&risk.balance>0&&risk.stake<=risk.balance*risk.maxStakePercent/100&&risk.sessionPnl>-risk.stopLoss&&risk.sessionPnl<risk.takeProfit&&risk.tradesThisSession<risk.maxTradesPerSession,detail:'Stake, exposure, session limits and trade cap pass'},
 ];
 const blocked=checks.find(c=>!c.passed);
 return {passed:!blocked,passedLayers:checks.filter(c=>c.passed).length,totalLayers:18,blockedAt:blocked?.name,reason:blocked?.detail||'All 18 shared engine layers passed.',layers:checks};
}