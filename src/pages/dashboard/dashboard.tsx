import React from 'react';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { useDevice } from '@deriv-com/ui';
import OnboardTourHandler from '../tutorials/dbot-tours/onboarding-tour';
import Announcements from './announcements';
import InfoPanel from './info-panel';
import EvenOddTerminal from './even-odd-terminal';
import './dante-landing.scss';

type TMobileIconGuide = {
    handleTabChange: (active_number: number) => void;
};

const DashboardComponent = observer(({ handleTabChange }: TMobileIconGuide) => {
    const { dashboard, client } = useStore();
    const { active_tab } = dashboard;
    const { isDesktop, isTablet } = useDevice();

    const handleConnectDeriv = async () => {
        const oauthUrl = await generateOAuthURL();
        if (oauthUrl) window.location.replace(oauthUrl);
    };

    return (
        <React.Fragment>
            <section className='db-landing' aria-label='Dante Builders platform overview'>
                <div className='db-landing__topbar'>
                    <div className='db-landing__brand'><span>DB</span><strong>DANTE BUILDERS</strong></div>
                    <nav aria-label='Platform navigation'><a href='#db-engine'>Engine</a><a href='#parity-bot'>Parity bot</a><a href='#db-markets'>Markets</a></nav>
                </div>
                <div className='db-landing__hero'>
                    <div className='db-landing__copy'>
                        <span className='db-landing__eyebrow'>DERIV MARKET INTELLIGENCE</span>
                        <h1>Clear market analysis. Disciplined parity execution.</h1>
                        <p>Analyze live Deriv ticks with an 18-stage Even/Odd engine. Review every decision gate and keep execution under your control.</p>
                        <div className='db-landing__actions'>
                            {client.is_logged_in ? <a href='#parity-bot' className='db-landing__primary'>Open parity bot</a> : <button type='button' className='db-landing__primary' onClick={handleConnectDeriv}>Connect Deriv account</button>}
                            <a href='#db-engine' className='db-landing__secondary'>Explore the engine</a>
                        </div>
                        <div className='db-landing__trust'>Analysis-first by default <span /> No martingale <span /> No profit guarantees</div>
                    </div>
                    <div className='db-landing__visual' aria-hidden='true'>
                        <div className='db-landing__visual-grid' />
                        <div className='db-landing__orb'><span>18</span><small>engine layers</small></div>
                        <div className='db-landing__visual-card db-landing__visual-card--top'><b>LIVE DATA</b><span>Tick validation</span></div>
                        <div className='db-landing__visual-card db-landing__visual-card--bottom'><b>ENTRY GATE</b><span>READY · WAIT · REJECTED</span></div>
                        <div className='db-landing__pulse' />
                    </div>
                </div>
                <div className='db-landing__features' id='db-engine'>
                    <article><span>01</span><strong>Live market feed</strong><p>Validated quotes, timestamps and market precision from Deriv.</p></article>
                    <article><span>02</span><strong>18 decision layers</strong><p>Parity recognition, rolling evidence, stability and risk gates.</p></article>
                    <article id='db-markets'><span>03</span><strong>Controlled execution</strong><p>Demo or live mode, one trade per fresh sample, and settlement tracking.</p></article>
                </div>
            </section>
            {client.is_logged_in && <Announcements is_mobile={!isDesktop} is_tablet={isTablet} handleTabChange={handleTabChange} />}
            {client.is_logged_in && <EvenOddTerminal />}
            <InfoPanel />
            {active_tab === 0 && <OnboardTourHandler is_mobile={!isDesktop} />}
        </React.Fragment>
    );
});

export default DashboardComponent;
