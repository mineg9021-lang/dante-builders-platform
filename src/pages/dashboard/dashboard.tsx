import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import EvenOddTerminal from './even-odd-terminal';
import DigitMatchesScanner from './digit-matches-scanner';
import './dante-landing.scss';

type Workspace = 'home' | 'parity' | 'matches' | 'xml';

const XML_ENTITIES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (value: string) => value.replace(/[<>&"']/g, char => XML_ENTITIES[char] || char);

const makeParityXml = (symbol: string, stake: number, duration: number, side: 'DIGITEVEN' | 'DIGITODD') => {
    const safeSymbol = escapeXml(symbol);
    return `<?xml version="1.0" encoding="UTF-8"?>
<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true" collection="false">
  <variables>
    <variable type="" id="dante_initialized" islocal="false" iscloud="false">DANTE:initialized</variable>
  </variables>
  <block type="trade_definition" id="dante_trade_definition" deletable="false" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" id="dante_market" deletable="false" movable="false">
        <field name="MARKET_LIST">volidx</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">${safeSymbol}</field>
        <next>
          <block type="trade_definition_tradetype" id="dante_trade_type" deletable="false" movable="false">
            <field name="TRADETYPECAT_LIST">digits</field>
            <field name="TRADETYPE_LIST">evenodd</field>
            <next>
              <block type="trade_definition_contracttype" id="dante_contract_type" deletable="false" movable="false">
                <field name="TYPE_LIST">both</field>
                <next>
                  <block type="trade_definition_candleinterval" id="dante_candle_interval" deletable="false" movable="false">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_restartbuysell" id="dante_restart_buy_sell" deletable="false" movable="false">
                        <field name="TIME_MACHINE_ENABLED">FALSE</field>
                        <next>
                          <block type="trade_definition_restartonerror" id="dante_restart_error" deletable="false" movable="false">
                            <field name="RESTARTONERROR">FALSE</field>
                          </block>
                        </next>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
    <statement name="INITIALIZATION">
      <block type="variables_set" id="dante_initialize">
        <field name="VAR" id="dante_initialized" variabletype="">DANTE:initialized</field>
        <value name="VALUE"><block type="logic_boolean" id="dante_initialized_true"><field name="BOOL">TRUE</field></block></value>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions" id="dante_trade_options">
        <mutation has_first_barrier="false" has_second_barrier="false" has_prediction="false"></mutation>
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION"><shadow type="math_number_positive" id="dante_duration"><field name="NUM">${duration}</field></shadow></value>
        <value name="AMOUNT"><shadow type="math_number_positive" id="dante_stake"><field name="NUM">${stake}</field></shadow></value>
      </block>
    </statement>
  </block>
  <block type="during_purchase" id="dante_during_purchase" x="720" y="0">
    <statement name="DURING_PURCHASE_STACK">
      <block type="controls_if" id="dante_sell_check">
        <value name="IF0"><block type="check_sell" id="dante_check_sell"></block></value>
        <statement name="DO0"><block type="sell_at_market" id="dante_sell_at_market"></block></statement>
      </block>
    </statement>
  </block>
  <block type="after_purchase" id="dante_after_purchase" x="720" y="248">
    <statement name="AFTERPURCHASE_STACK"><block type="trade_again" id="dante_trade_again"></block></statement>
  </block>
  <block type="before_purchase" id="dante_before_purchase" deletable="false" x="0" y="576">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase" id="dante_purchase"><field name="PURCHASE_LIST">${side}</field></block>
    </statement>
  </block>
</xml>`;
};

const validateParityXml = (xml: string) => {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length > 0) return { valid: false, errors: ['XML is not well-formed.'] };
    const blocks = Array.from(parsed.getElementsByTagName('block'));
    const hasBlock = (type: string) => blocks.some(block => block.getAttribute('type') === type);
    const required = ['trade_definition', 'before_purchase', 'during_purchase', 'after_purchase'];
    const missing = required.filter(type => !hasBlock(type));
    const tradeDefinition = blocks.find(block => block.getAttribute('type') === 'trade_definition');
    const initialized = tradeDefinition
        ? Array.from(tradeDefinition.getElementsByTagName('statement')).some(statement =>
              statement.getAttribute('name') === 'INITIALIZATION' && statement.getElementsByTagName('block').length > 0
          )
        : false;
    if (!initialized) missing.push('Run Once at Start initialization');
    return { valid: missing.length === 0, errors: missing.map(item => `Missing required section: ${item}`) };
};

const DashboardComponent = observer(() => {
    const { client } = useStore();
    const [workspace, setWorkspace] = useState<Workspace>('home');
    const [loginError, setLoginError] = useState('');
    const [request, setRequest] = useState('');
    const [symbol, setSymbol] = useState('R_100');
    const [stake, setStake] = useState('1');
    const [duration, setDuration] = useState('5');
    const [side, setSide] = useState<'DIGITEVEN' | 'DIGITODD'>('DIGITEVEN');
    const [generatedXml, setGeneratedXml] = useState('');
    const [validation, setValidation] = useState<{ valid: boolean; errors: string[] } | null>(null);
    const [aiStatus, setAiStatus] = useState('AI service is optional; verified local generation is available.');
    const [generating, setGenerating] = useState(false);

    const connectDeriv = async () => {
        setLoginError('');
        try {
            const url = await generateOAuthURL();
            if (!url) throw new Error('Deriv sign-in could not be started. Check the registered OAuth application settings.');
            window.location.assign(url);
        } catch (error) {
            setLoginError(error instanceof Error ? error.message : 'Unable to start Deriv sign-in.');
        }
    };

    const generateXml = async () => {
        setGenerating(true);
        setValidation(null);
        let resolvedSide = side;
        let resolvedSymbol = symbol;
        let resolvedStake = Number(stake);
        let resolvedDuration = Number(duration);
        let usedAi = false;
        if (request.trim()) {
            try {
                const response = await fetch('/.netlify/functions/generate-xml', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: request.slice(0, 2000), defaults: { side, symbol, stake: resolvedStake, duration: resolvedDuration } }),
                });
                const result = await response.json();
                if (response.ok && result?.supported === false) {
                    setValidation({ valid: false, errors: [result.reason || 'This request is outside the supported DBot generator scope.'] });
                    setAiStatus('AI analysis rejected an unsupported contract request.');
                    setGenerating(false);
                    return;
                }
                if (response.ok && result?.supported === true) {
                    resolvedSide = result.contract;
                    resolvedSymbol = result.symbol;
                    resolvedStake = Number(result.stake);
                    resolvedDuration = Number(result.duration);
                    usedAi = true;
                } else {
                    setAiStatus(result?.error === 'AI_PROVIDER_NOT_CONFIGURED'
                        ? 'AI provider key is not configured in Netlify yet; verified local generation was used.'
                        : 'AI service was unavailable; verified local generation was used.');
                }
            } catch {
                setAiStatus('AI endpoint is not reachable yet; verified local generation was used.');
            }
            if (!usedAi) {
                const normalized = request.toLowerCase();
                if (/\b(matches?|differs?|over|under|rise|fall)\b/.test(normalized)) {
                    setValidation({ valid: false, errors: ['This contract type is not yet supported by the verified local XML template. Select an Even or Odd digit contract instead.'] });
                    setAiStatus('Unsupported contract request rejected; no substitute strategy was generated.');
                    setGenerating(false);
                    return;
                }
                resolvedSide = /\bodd\b/.test(normalized) ? 'DIGITODD' : /\beven\b/.test(normalized) ? 'DIGITEVEN' : side;
                resolvedSymbol = (request.match(/\bR_(?:10|25|50|75|100)(?:_1S)?\b/i)?.[0] || symbol).toUpperCase();
                resolvedStake = Number(request.match(/stake\s*(?:of|:|=)?\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1] || stake);
                resolvedDuration = Number(request.match(/(\d+)\s*ticks?/i)?.[1] || duration);
            }
        } else {
            setAiStatus('Using verified local DBot template from the selected settings.');
        }

        if (!['DIGITEVEN', 'DIGITODD'].includes(resolvedSide)) {
            setValidation({ valid: false, errors: ['Only Even and Odd digit contracts are currently supported by this verified XML template.'] });
            setGenerating(false);
            return;
        }
        if (!Number.isFinite(resolvedStake) || resolvedStake <= 0 || resolvedStake > 100000) {
            setValidation({ valid: false, errors: ['Enter a positive stake within the supported range.'] });
            setGenerating(false);
            return;
        }
        if (!Number.isInteger(resolvedDuration) || resolvedDuration < 1 || resolvedDuration > 10) {
            setValidation({ valid: false, errors: ['Duration must be between 1 and 10 ticks for this generator template.'] });
            setGenerating(false);
            return;
        }
        const xml = makeParityXml(resolvedSymbol, resolvedStake, resolvedDuration, resolvedSide);
        const result = validateParityXml(xml);
        setGeneratedXml(xml);
        setValidation(result);
        setSide(resolvedSide);
        setSymbol(resolvedSymbol);
        setStake(String(resolvedStake));
        setDuration(String(resolvedDuration));
        if (usedAi) setAiStatus('AI interpreted your request; XML was assembled from verified DBot blocks and passed structural validation.');
        setGenerating(false);
    };

    const downloadXml = () => {
        if (!generatedXml || !validation?.valid) return;
        const blob = new Blob([generatedXml], { type: 'application/xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `dante-${side.toLowerCase()}-${symbol.toLowerCase()}.xml`;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    return (
        <main className="dante-app">
            <header className="dante-header">
                <button className="dante-brand" type="button" onClick={() => setWorkspace('home')}><span className="dante-brand-mark">DB</span><span>DANTE BUILDERS</span></button>
                <nav aria-label="Product workspaces">
                    <button className={workspace === 'home' ? 'active' : ''} onClick={() => setWorkspace('home')}>Home</button>
                    <button className={workspace === 'parity' ? 'active' : ''} onClick={() => setWorkspace('parity')}>Parity Bot</button>
                    <button className={workspace === 'matches' ? 'active' : ''} onClick={() => setWorkspace('matches')}>Matches Scanner</button>
                    <button className={workspace === 'xml' ? 'active' : ''} onClick={() => setWorkspace('xml')}>XML Generator</button>
                </nav>
                <span className={client.is_logged_in ? 'connection connected' : 'connection'}>{client.is_logged_in ? 'TRADING SESSION CONNECTED' : 'TRADING SESSION REQUIRED'}</span>
            </header>

            {workspace === 'home' && <section className="dante-home">
                <div className="dante-hero">
                    <div><span className="dante-kicker">INDEPENDENT MARKET TECHNOLOGY</span><h1>Build with intelligence.<br/><em>Operate with control.</em></h1><p>Dante Builders brings three focused tools into one clean workspace. Each product has its own engine, controls and validation.</p><div className="dante-hero-actions"><button className="primary" onClick={() => setWorkspace('parity')}>Open Parity Bot</button><button className="secondary" onClick={() => setWorkspace('matches')}>Explore Market Scanner</button></div></div>
                    <div className="dante-hero-art" aria-hidden="true"><div className="orbit orbit-one"></div><div className="orbit orbit-two"></div><div className="core">D<span>B</span></div><div className="float-chip chip-a">LIVE DATA</div><div className="float-chip chip-b">ENGINE ACTIVE</div></div>
                </div>
                <div className="dante-products-heading"><span>PRODUCT WORKSPACES</span><h2>Choose your tool</h2><p>Three separate products. No legacy bot-builder clutter.</p></div>
                <div className="dante-product-grid">
                    <button className="product-tile parity-tile" onClick={() => setWorkspace('parity')}><span className="tile-icon">±</span><strong>Even / Odd Parity Bot</strong><p>Market sampling, parity analysis, risk gates and guarded execution.</p><b>Open workspace <i>↗</i></b></button>
                    <button className="product-tile scanner-tile" onClick={() => setWorkspace('matches')}><span className="tile-icon">◎</span><strong>Digit Intelligence Matches Scanner</strong><p>Live tick collection, precision-aware digit analysis and Matches/Differs evidence.</p><b>Open scanner <i>↗</i></b></button>
                    <button className="product-tile xml-tile" onClick={() => setWorkspace('xml')}><span className="tile-icon">&lt;/&gt;</span><strong>AI Deriv XML Bots Generator</strong><p>Generate a supported DBot strategy, validate required sections and download XML.</p><b>Open generator <i>↗</i></b></button>
                </div>
            </section>}

            {workspace === 'parity' && <section className="dante-workspace">
                <div className="workspace-heading"><div><span>EXECUTION ENGINE</span><h1>Even / Odd Parity Bot</h1><p>Fresh tick validation, bounded analysis, contract checks and account-level risk controls.</p></div><button onClick={() => setWorkspace('home')}>← All products</button></div>
                {client.is_logged_in ? <EvenOddTerminal /> : <div className="connect-panel"><h2>Connect your Deriv account</h2><p>Authentication is required for account balance, proposals, purchases and settlement monitoring.</p><button className="primary" onClick={connectDeriv}>Connect Deriv securely</button>{loginError && <p role="alert">{loginError}</p>}</div>}
            </section>}

            {workspace === 'matches' && <section className="dante-workspace">
                <div className="workspace-heading"><div><span>MARKET INTELLIGENCE ENGINE</span><h1>Digit Intelligence Matches Scanner AI</h1><p>Live market feed, 0–9 distribution, rolling sample analysis and evidence-led Matches/Differs candidates.</p></div><button onClick={() => setWorkspace('home')}>← All products</button></div>
                <DigitMatchesScanner />
            </section>}

            {workspace === 'xml' && <section className="dante-workspace xml-workspace">
                <div className="workspace-heading"><div><span>DBOT XML ENGINE</span><h1>AI Deriv XML Bots Generator</h1><p>Describe a supported Even/Odd strategy. The local generator builds real DBot blocks, checks the required sections and exports an XML file.</p></div><button onClick={() => setWorkspace('home')}>← All products</button></div>
                <div className="generator-panel">
                    <label>Describe the bot strategy<textarea value={request} onChange={event => setRequest(event.target.value)} placeholder="Describe the market, contract, stake, duration, entry logic and exit rules you want…"></textarea></label>
                    <div className="generator-fields">
                        <label>Market<select value={symbol} onChange={event => setSymbol(event.target.value)}>{['R_10','R_10_1S','R_25','R_25_1S','R_50','R_50_1S','R_75','R_75_1S','R_100','R_100_1S'].map(value => <option key={value}>{value}</option>)}</select></label>
                        <label>Contract<select value={side} onChange={event => setSide(event.target.value as 'DIGITEVEN' | 'DIGITODD')}><option value="DIGITEVEN">Even</option><option value="DIGITODD">Odd</option></select></label>
                        <label>Stake<input type="number" min="0.35" step="0.01" value={stake} onChange={event => setStake(event.target.value)}/></label>
                        <label>Duration (ticks)<input type="number" min="1" max="10" step="1" value={duration} onChange={event => setDuration(event.target.value)}/></label>
                    </div>
                    <button className="primary generate-button" onClick={generateXml} disabled={generating}>{generating ? 'Generating…' : 'Generate and validate XML'}</button>
                    <p className="generator-note">{aiStatus} Current verified XML template supports Even/Odd digit contracts; unsupported contract requests are rejected rather than converted.</p>
                    {validation && <div className={validation.valid ? 'validation-result valid' : 'validation-result invalid'}><strong>{validation.valid ? 'XML VALIDATION PASSED' : 'VALIDATION NEEDS ATTENTION'}</strong>{validation.errors.map(error => <p key={error}>{error}</p>)}{validation.valid && <p>Trade Parameters · Run Once at Start · Purchase Conditions · Sell Conditions · Restart Trading Conditions</p>}</div>}
                    {generatedXml && <div className="xml-output"><div><strong>Generated DBot XML</strong><button onClick={downloadXml} disabled={!validation?.valid}>Download XML</button></div><pre>{generatedXml}</pre></div>}
                </div>
            </section>}
            <footer className="dante-footer"><span>DANTE BUILDERS</span><span>Independent tools · Evidence before execution</span></footer>
        </main>
    );
});

export default DashboardComponent;
