import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ToastContainer } from 'react-toastify';
import ChunkLoader from '@/components/loader/chunk-loader';
import { ApiHelpers, ServerTime } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import { ThemeProvider } from '@deriv-com/quill-ui';
import { localize } from '@deriv-com/translations';
import Dashboard from '../pages/dashboard/dashboard';
import 'react-toastify/dist/ReactToastify.css';

const AppContent = observer(() => {
    const store = useStore();
    const { app, common } = store;
    const { is_dark_mode_on } = useThemeSwitcher();
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let attempts = 0;
        let interval;
        try {
            ServerTime.init(common);
            app.setDBotEngineStores();
            ApiHelpers.setInstance(app.api_helpers_store);
        } catch (error) {
            console.error('Dante engine initialization failed:', error);
            setReady(true);
            return;
        }

        const loadSymbols = () => {
            const activeSymbols = ApiHelpers?.instance?.active_symbols;
            if (!activeSymbols) {
                attempts += 1;
                if (attempts >= 12) {
                    if (!cancelled) setReady(true);
                    if (interval) clearInterval(interval);
                }
                return;
            }
            if (interval) clearInterval(interval);
            Promise.resolve(activeSymbols.retrieveActiveSymbols(true))
                .catch(error => console.error('Market catalogue load failed:', error))
                .finally(() => { if (!cancelled) setReady(true); });
        };

        interval = window.setInterval(loadSymbols, 250);
        loadSymbols();
        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, [app, common]);

    if (!store || !ready) return <ChunkLoader message={localize('Preparing Dante workspaces…')} />;

    return (
        <ThemeProvider theme={is_dark_mode_on ? 'dark' : 'light'}>
            <Dashboard />
            <ToastContainer limit={3} draggable={false} />
        </ThemeProvider>
    );
});

export default AppContent;
