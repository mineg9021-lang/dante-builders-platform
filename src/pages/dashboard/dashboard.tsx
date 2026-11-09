import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import EvenOddTerminal from './even-odd-terminal';
import './dante-landing.scss';

type TMobileIconGuide = {
    handleTabChange: (active_number: number) => void;
};

const DashboardComponent = observer((_props: TMobileIconGuide) => {
    const { client } = useStore();
    const [section, setSection] = useState<'overview' | 'parity' | 'matches' | 'xml'>('overview');
    const [loginError, setLoginError] = useState('');

    const handleConnectDeriv = async () => {
        setLoginError('');
        try {
            const oauthUrl = await generateOAuthURL();
            if (!oauthUrl) {
                setLoginError('Deriv sign-in could not be started. Please check the registered OAuth application settings.');
                return;
            }
            window.location.assign(oauthUrl);
        } catch {
            setLoginError('Unable to start Deriv sign-in. Please try again.');
        }
    };

    return (
        <main className='db-platform'>
            <header className='db-platform__header'>
                <a className='db-platform__brand' href='/' onClick={event => { event.preventDefault(); setSection('overview'); }}>
                    <span>DB</span><strong>DANTE BUILDERS</strong>
                </a>
                <nav className='db-platform__nav' aria-label='Main navigation'>
                    <button type='button' className={section === 'overview' ? 'is-active' : ''} onClick={() => setSection('overview')}>Dashboard</button>
                    <button type='button' className={section === 'parity' ? 'is-active' : ''} onClick={() => setSection('parity')}>Parity Bot</button>
                    <button type='button' className={section === 'matches' ? 'is-active' : ''} onClick={() => setSection('matches')}>Matches Scanner</button>
                    <button type='button' className={section === 'xml' ? 'is-active' : ''} onClick={() => setSection('xml')}>XML Generator</button>
                </nav>
                <span className='db-platform__account'>{client.is_logged_in ? 'DERIV CONNECTED' : 'ACCOUNT NOT CONNECTED'}</span>
            </header>

            {section === 'overview' ? (
                <section className='db-platform__overview'>
                    <div className='db-platform__hero'>
                        <div className='db-platform__copy'>
                            <span className='db-platform__eyebrow'>DANTE BUILDERS · DERIV PLATFORM</span>
                            <h1>Market analysis, with control in your hands.</h1>
                            <p>A focused workspace for reviewing market activity and accessing your Even/Odd parity bot when you need it.</p>
                            <div className='db-platform__actions'>
                                <button type='button' className='db-platform__primary' onClick={() => client.is_logged_in ? setSection('parity') : handleConnectDeriv()}>
                                    {client.is_logged_in ? 'Open Parity Bot' : 'Connect Deriv account'}
                                </button>
                                <button type='button' className='db-platform__secondary' onClick={() => setSection('parity')}>Go to Parity Bot</button>
                            </div>
                            {loginError && <p className='db-platform__error' role='alert'>{loginError}</p>}
                            <div className='db-platform__trust'><span>Analysis-first</span><span>No martingale</span><span>No profit guarantees</span></div>
                        </div>
                        <div className='db-platform__visual' aria-hidden='true'>
                            <div className='db-platform__visual-orbit'><span>DB</span></div>
                            <div className='db-platform__visual-chip db-platform__visual-chip--one'>MARKET INSIGHT</div>
                            <div className='db-platform__visual-chip db-platform__visual-chip--two'>CONTROLLED EXECUTION</div>
                        </div>
                    </div>
                    <div className='db-platform__welcome'>
                        <div><span>YOUR WORKSPACE</span><h2>Everything in its place.</h2><p>Open the dedicated Parity Bot section to analyze live ticks, review its signal and manage execution settings.</p></div>
                        <button type='button' onClick={() => setSection('parity')}>Open Parity Bot <span aria-hidden='true'>→</span></button>
                    </div>
                </section>
            ) : section === 'parity' ? (
                <section className='db-platform__bot-section'>
                    <div className='db-platform__section-heading'><div><span>TRADING WORKSPACE</span><h1>Even / Odd Parity Bot</h1><p>Live market analysis and controlled execution.</p></div><button type='button' onClick={() => setSection('overview')}>← Dashboard</button></div>
                    {client.is_logged_in ? <EvenOddTerminal /> : <div className='db-platform__connect-card'><h2>Connect your Deriv account</h2><p>Sign in securely to use the parity bot.</p><button type='button' className='db-platform__primary' onClick={handleConnectDeriv}>Connect Deriv account</button>{loginError && <p className='db-platform__error'>{loginError}</p>}</div>}
                </section>
            ) : section === 'matches' ? (
                <section className='db-platform__bot-section db-product-page'>
                    <div className='db-product-hero'><div className='db-robot-art' aria-hidden='true'><div className='db-robot-halo'></div><div className='db-robot-head'><i></i><b></b><span></span></div></div><div><span className='db-product-kicker'>DANTE MARKET INTELLIGENCE</span><h1>Digit Intelligence Matches Scanner AI</h1><p>Independent ten-digit analysis for Matches and Differs. Scanner mode only; no trades are placed.</p><div className='db-product-pills'><span>Live market data</span><span>10-digit analysis</span><span>Execution disabled</span></div></div></div>
                    <div className='db-product-card'><div className='db-product-controls'><label>Deriv market<select defaultValue='R_10'><option value='R_10'>Volatility 10</option><option value='R_25'>Volatility 25</option><option value='R_50'>Volatility 50</option><option value='R_75'>Volatility 75</option><option value='R_100'>Volatility 100</option><option value='1HZ10V'>Volatility 10 (1s)</option><option value='1HZ25V'>Volatility 25 (1s)</option><option value='1HZ50V'>Volatility 50 (1s)</option><option value='1HZ75V'>Volatility 75 (1s)</option><option value='1HZ100V'>Volatility 100 (1s)</option></select></label><span className='db-status-wait'>● Awaiting live scanner connection</span><button type='button' disabled={!client.is_logged_in} title='Live scanner stream is not yet integrated'>Start Scanner</button></div><div className='db-scanner-empty'><strong>Scanner engine awaiting market stream</strong><p>Live analysis is not enabled yet. No sample digits, signals or probabilities are fabricated.</p></div><div className='db-digit-grid'>{Array.from({length:10},(_,digit)=><div key={digit}><b>{digit}</b><span>—</span></div>)}</div><div className='db-analysis-columns'><article><h3>Matches candidates</h3><p>Waiting for validated observations</p></article><article><h3>Differs candidates</h3><p>Waiting for validated observations</p></article></div></div><button className='db-back-link' type='button' onClick={() => setSection('overview')}>← Back to dashboard</button>
                </section>
            ) : (
                <section className='db-product-page db-xml-page'><div className='db-xml-hero'><div className='db-xml-orb'>AI</div><span className='db-product-kicker'>DANTE BUILDERS · DBOT WORKSPACE</span><h1>AI Deriv XML Bots Generator</h1><p>Describe the bot you want. The generator will use DBot structure and validate the required XML sections.</p></div><div className='db-product-card'><label className='db-request-label'>Describe your bot<textarea id='dante-xml-request' placeholder='Describe the market, contract, entry rules, exit rules, risk limits and restart behaviour…' rows={6}></textarea></label><div className='db-xml-sections'><span>Trade Parameters</span><span>Purchase Conditions</span><span>Sell Conditions</span><span>Restart Trading Conditions</span><span>Run Once at Start</span></div><button type='button' disabled className='db-xml-generate' title='Secure server-side AI provider connection is required'>Generate complete XML</button><p className='db-xml-note'>AI generation is not enabled: no server-side AI provider is configured. No example bots or fabricated XML are displayed.</p></div><button className='db-back-link' type='button' onClick={() => setSection('overview')}>← Back to dashboard</button></section>
            )}
        </main>
    );
});

export default DashboardComponent;
