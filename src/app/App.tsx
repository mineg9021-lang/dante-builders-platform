import { Suspense, useEffect, useState } from 'react';
import React from 'react';
import { createBrowserRouter, createRoutesFromElements, Outlet, Route, RouterProvider } from 'react-router';
import { cleanupUrl, handleOAuthCallback } from '@/external/deriv-core';
import { getOAuthRedirectUri } from '@/external/deriv-core/config/urls';
import ChunkLoader from '@/components/loader/chunk-loader';
import LocalStorageSyncWrapper from '@/components/localStorage-sync-wrapper';
import { useAccountSwitching } from '@/hooks/useAccountSwitching';
import { useLanguageFromURL } from '@/hooks/useLanguageFromURL';
import { StoreProvider } from '@/hooks/useStore';
import { isPreviewMode, PREVIEW_BASE_PATH } from '@/utils/is-preview-mode';
import { localize, TranslationProvider } from '@deriv-com/translations';
import CoreStoreProvider from './CoreStoreProvider';
import i18nInstance from './i18n';
import './app-root.scss';

const AppRoot = React.lazy(() => import('./app-root'));

const LanguageHandler = ({ children }: { children: React.ReactNode }) => {
    useLanguageFromURL();
    return <>{children}</>;
};

const routerBasename = isPreviewMode() ? PREVIEW_BASE_PATH : undefined;

const router = createBrowserRouter(
    createRoutesFromElements(
        <Route path='/' element={
            <Suspense fallback={<ChunkLoader message={localize('Loading Dante Builders…')} />}>
                <TranslationProvider defaultLang='EN' i18nInstance={i18nInstance}>
                    <LanguageHandler>
                        <StoreProvider>
                            <LocalStorageSyncWrapper>
                                <CoreStoreProvider>
                                    <Outlet />
                                </CoreStoreProvider>
                            </LocalStorageSyncWrapper>
                        </StoreProvider>
                    </LanguageHandler>
                </TranslationProvider>
            </Suspense>
        }>
            <Route index element={<AppRoot />} />
            <Route path='preview' element={<AppRoot />} />
            <Route path='*' element={<AppRoot />} />
        </Route>
    ),
    { basename: routerBasename }
);

function App() {
    useAccountSwitching();
    const [oauthProcessing, setOauthProcessing] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        return params.has('code') || params.has('error');
    });
    const [oauthError, setOauthError] = useState('');

    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        if (!urlParams.has('code') && !urlParams.has('error')) { setOauthProcessing(false); return; }

        const handleCallback = async () => {
            try {
                await handleOAuthCallback(window.location.href, {
                    clientId: process.env.NEXT_PUBLIC_DERIV_APP_ID || '',
                    redirectUri: getOAuthRedirectUri(),
                    scopes: 'trade',
                });
                const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
                const accounts = await DerivWSAccountsService.fetchAccountsList();
                if (accounts && accounts.length > 0) {
                    DerivWSAccountsService.storeAccounts(accounts);
                    const firstAccount = accounts[0];
                    localStorage.setItem('active_loginid', firstAccount.account_id);
                    const isDemo = firstAccount.account_type === 'demo' || firstAccount.account_id.startsWith('VRT');
                    localStorage.setItem('account_type', isDemo ? 'demo' : 'real');
                } else {
                    throw new Error('Deriv authentication succeeded, but no trading accounts were returned.');
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Deriv sign-in could not be completed.';
                console.error('OAuth callback failed:', message);
                setOauthError(message);
            } finally {
                cleanupUrl(getOAuthRedirectUri());
                setOauthProcessing(false);
            }
        };
        handleCallback();
    }, []);

    if (oauthProcessing) return <div role='status' style={{minHeight:'100vh',display:'grid',placeItems:'center',fontFamily:'system-ui',color:'#312e81'}}>Completing secure Deriv connection…</div>;
    return <><RouterProvider router={router} />{oauthError && <div role='alert' style={{position:'fixed',left:16,right:16,bottom:16,zIndex:9999,padding:16,borderRadius:12,background:'#fff1f2',color:'#9f1239',boxShadow:'0 8px 30px #0002'}}><strong>Deriv connection failed</strong><p>{oauthError}</p><button type='button' onClick={() => setOauthError('')}>Dismiss</button></div>}</>;
}

export default App;
