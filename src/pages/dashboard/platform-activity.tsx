import React, { useEffect, useState } from 'react';
import { loadDanteJournal, type DanteJournalEvent } from '@/services/dante-journal.service';

type Activity = { id: string; title: string; detail: string; time: number; tone: string };

const toActivity = (event: DanteJournalEvent): Activity | null => {
    const data = event.event_data || {};
    const time = new Date(event.created_at).getTime();
    const id = String(event.id || event.contract_id || event.created_at);
    const account = event.deriv_account_id ? ' · ' + event.deriv_account_id : '';
    if (event.event_type === 'RUNTIME_STATUS') {
        const status = String(data.status || '');
        const labels: Record<string, [string, string, string]> = {
            STARTING: ['Dante engine initialized', 'Preparing live market subscriptions and contract checks.', 'neutral'],
            RUNNING: ['Market analysis active', 'The platform is evaluating fresh market data.', 'success'],
            EXECUTING: ['Opportunity entered validation', 'The strategy candidate is being checked against contract and risk rules.', 'warning'],
            STOPPED: ['Bot session stopped', 'No further purchases will be initiated.', 'neutral'],
            PAUSED_ERROR: ['Engine paused safely', String(data.message || 'Execution paused. Review the reason before restarting.'), 'error'],
        };
        const row = labels[status];
        return row ? { id, title: row[0], detail: row[1] + account, time, tone: row[2] } : null;
    }
    if (event.event_type === 'DECISION') {
        const decision = String(data.decision || '');
        const labels: Record<string, [string, string, string]> = {
            READY: ['AI opportunity qualified', 'A strategy candidate passed its analysis threshold.', 'success'],
            WAIT: ['AI analysis continuing', String(data.reason || 'The current sample has not qualified an entry.'), 'neutral'],
            REJECTED: ['Opportunity rejected', String(data.reason || 'The candidate did not pass validation. No purchase was made.'), 'warning'],
        };
        const row = labels[decision];
        return row ? { id, title: row[0], detail: row[1] + account, time, tone: row[2] } : null;
    }
    if (event.event_type === 'PURCHASED') {
        return { id, title: 'Trade purchase confirmed', detail: String(data.contractType || 'Contract') + ' · ' + String(data.symbol || 'Market') + ' · Contract ' + String(event.contract_id || '—') + account, time, tone: 'success' };
    }
    if (event.event_type === 'SETTLED') {
        const settlement = String(data.settlement || 'SETTLED');
        return { id, title: 'Trade result verified', detail: settlement + ' · P/L ' + String(data.profit ?? '—') + account, time, tone: settlement === 'WON' ? 'success' : settlement === 'LOST' ? 'warning' : 'neutral' };
    }
    return null;
};

const PlatformActivity = () => {
    const [activities, setActivities] = useState<Activity[]>([]);
    const [loadError, setLoadError] = useState('');
    useEffect(() => {
        let active = true;
        const refresh = () => {
            void loadDanteJournal().then(events => {
                if (active) setActivities(events.map(toActivity).filter((item): item is Activity => Boolean(item)).slice(0, 30));
            }).catch(() => {
                if (active) setLoadError('Platform activity is temporarily unavailable.');
            });
        };
        const handleNewEvent = (event: Event) => {
            const detail = (event as CustomEvent<DanteJournalEvent>).detail;
            const item = detail ? toActivity(detail) : null;
            if (item) setActivities(previous => [item, ...previous.filter(row => row.id !== item.id)].slice(0, 30));
        };
        refresh();
        window.addEventListener('dante:journal-event', handleNewEvent);
        return () => {
            active = false;
            window.removeEventListener('dante:journal-event', handleNewEvent);
        };
    }, []);
    return (
        <section className='dante-activity' id='platform-activity'>
            <div className='dante-section-heading compact'>
                <div><span className='dante-eyebrow'>DANTE AI CORE · SYSTEM EVENTS</span><h3>Platform activity</h3></div>
                <span>{activities.length} recent events</span>
            </div>
            {loadError && <p className='runtime-message' role='status'>{loadError}</p>}
            {activities.length ? (
                <ol className='dante-activity-list'>
                    {activities.slice(0, 20).map(item => (
                        <li key={item.id} className={'activity-' + item.tone}>
                            <span className='activity-marker' />
                            <div><strong>{item.title}</strong><p>{item.detail}</p></div>
                            <time>{Number.isFinite(item.time) ? new Date(item.time).toLocaleString() : ''}</time>
                        </li>
                    ))}
                </ol>
            ) : <div className='dante-empty-journal'>Platform activity will appear when the engine connects, analyzes a market or processes a verified contract.</div>}
        </section>
    );
};

export default PlatformActivity;
