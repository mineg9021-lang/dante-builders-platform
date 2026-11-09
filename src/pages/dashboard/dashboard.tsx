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
    const [section, setSection] = useState<'overview' | 'parity'>('overview');
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
            ) : (
                <section className='db-platform__bot-section'>
                    <div className='db-platform__section-heading'>
                        <div><span>TRADING WORKSPACE</span><h1>Even / Odd Parity Bot</h1><p>Live market analysis and controlled execution.</p></div>
                        <button type='button' onClick={() => setSection('overview')}>← Back to Dashboard</button>
                    </div>
                    {client.is_logged_in ? (
                        <EvenOddTerminal />
                    ) : (
                        <div className='db-platform__connect-card'>
                            <h2>Connect your Deriv account</h2>
                            <p>Sign in securely with Deriv to open the parity bot and receive live market data.</p>
                            <button type='button' className='db-platform__primary' onClick={handleConnectDeriv}>Connect Deriv account</button>
                            {loginError && <p className='db-platform__error' role='alert'>{loginError}</p>}
                        </div>
                    )}
                </section>
            )}
        </main>
    );
});

export default DashboardComponent;
