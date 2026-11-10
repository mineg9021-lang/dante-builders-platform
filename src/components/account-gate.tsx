import React, { FormEvent, useEffect, useState } from 'react';
import './account-gate.scss';

type PlatformUser = { id: string; email: string };
type Props = { children: React.ReactNode };

const DanteAccountGate = ({ children }: Props) => {
    const [user, setUser] = useState<PlatformUser | null>(null);
    const [loading, setLoading] = useState(true);
    const [mode, setMode] = useState<'login' | 'signup'>('signup');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        try {
            const response = await fetch('/.netlify/functions/account-auth', { credentials: 'same-origin' });
            const result = await response.json();
            setUser(response.ok && result.authenticated ? result.user : null);
            if (response.status === 503) setMessage(result.message || 'Platform accounts are not configured.');
        } catch {
            setUser(null);
            setMessage('Account service is unavailable. Please try again later.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void refresh(); }, []);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setMessage('');
        if (mode === 'signup' && password !== confirmPassword) {
            setMessage('The passwords do not match.');
            return;
        }
        setBusy(true);
        try {
            const response = await fetch('/.netlify/functions/account-auth', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: mode, email, password }),
            });
            const result = await response.json();
            if (!response.ok) {
                setMessage(result.message || 'Account request failed.');
            } else if (result.authenticated && result.user) {
                setUser(result.user);
                setPassword('');
                setConfirmPassword('');
            } else {
                setMessage(result.message || 'Check your email and sign in to continue.');
                if (result.confirmationRequired) setMode('login');
            }
        } catch {
            setMessage('Could not reach the account service. Please retry.');
        } finally {
            setBusy(false);
        }
    };

    const logout = async () => {
        await fetch('/.netlify/functions/account-auth', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'logout' }),
        });
        setUser(null);
        setMode('login');
        setMessage('You have been signed out.');
    };

    if (loading) return <div className='dante-account-loading'>Loading secure Dante account…</div>;
    if (user) return <div className='dante-account-shell'><div className='dante-account-bar'><span>Signed in as <strong>{user.email}</strong></span><button type='button' onClick={logout}>Sign out</button></div>{children}</div>;

    return (
        <main className='dante-account-page'>
            <section className='dante-account-card'>
                <div className='dante-account-mark'>DB</div>
                <span className='dante-account-kicker'>DANTE BUILDERS · SECURE ACCESS</span>
                <h1>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
                <p>Register or sign in to access your separate bot workspaces. Deriv connection is a separate step inside the platform.</p>
                <form onSubmit={submit}>
                    <label>Email address<input type='email' autoComplete='email' required value={email} onChange={event => setEmail(event.target.value)} /></label>
                    <label>Password<input type='password' autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /></label>
                    {mode === 'signup' && <label>Confirm password<input type='password' autoComplete='new-password' minLength={8} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></label>}
                    <button type='submit' disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
                </form>
                {message && <p className='dante-account-message' role='status'>{message}</p>}
                <button className='dante-account-switch' type='button' onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setMessage(''); }}>
                    {mode === 'signup' ? 'Already registered? Sign in' : 'New to Dante Builders? Create an account'}
                </button>
                <small>Account passwords are verified by the configured authentication provider. Do not reuse your Deriv password.</small>
            </section>
        </main>
    );
};

export default DanteAccountGate;
