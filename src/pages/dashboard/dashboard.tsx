import React, { useState } from 'react';
import DanteAccountGate from '@/components/account-gate';
import { generateOAuthURL } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import EvenOddTerminal from './even-odd-terminal';
import './prime-dashboard.scss';

const PrimeDashboard = () => {
    const { isAuthorized, connectionStatus, authData, accountList, activeLoginid } = useApiBase();
    const [connecting, setConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState('');
    const connected = isAuthorized && connectionStatus === 'opened';

    const connectDeriv = async () => {
        setConnecting(true);
        setConnectionError('');
        try {
            const url = await generateOAuthURL();
            if (!url) throw new Error('Deriv sign-in could not be started. Check the registered OAuth callback URL.');
            window.location.assign(url);
        } catch (error) {
            setConnectionError(error instanceof Error ? error.message : 'Unable to start secure Deriv authorization.');
            setConnecting(false);
        }
    };

    return (
        <main className='prime-dashboard'>
            <div className='prime-account-strip'>
                <div><span>DERIV ACCOUNT</span><strong>{connected ? activeLoginid || authData?.loginid : 'Not connected'}</strong></div>
                <div><span>ACCOUNT TYPE</span><strong>{connected ? (authData?.is_virtual ? 'DEMO' : 'REAL') : '—'}</strong></div>
                <div><span>CONNECTION</span><strong className={connected ? 'is-connected' : ''}>{connected ? 'CONNECTED' : 'OFFLINE'}</strong></div>
                <button type='button' onClick={connectDeriv} disabled={connecting}>{connecting ? 'CONNECTING…' : connected ? 'RECONNECT DERIV' : 'CONNECT DERIV'}</button>
            </div>
            {connectionError && <p className='prime-connect-error' role='alert'>{connectionError}</p>}
            {connected && accountList.length > 0 && <p className='prime-account-note'>Secure Deriv session active · {accountList.length} account(s) available. Choose the active account in your Deriv account menu.</p>}
            <EvenOddTerminal />
        </main>
    );
};

const PlatformDashboard = () => <DanteAccountGate><PrimeDashboard /></DanteAccountGate>;
export default PlatformDashboard;
