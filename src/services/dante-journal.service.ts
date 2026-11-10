export type DanteJournalEvent = {
    id: number;
    bot_key: string;
    deriv_account_id: string | null;
    contract_id: number | null;
    event_type: 'PURCHASED' | 'SETTLED' | 'DECISION' | 'RUNTIME_STATUS';
    event_data: Record<string, unknown>;
    created_at: string;
};
export type DanteJournalWrite = {
    botKey: string;
    derivAccountId?: string;
    contractId?: number;
    eventType: DanteJournalEvent['event_type'];
    eventData: Record<string, unknown>;
};
export async function loadDanteJournal(): Promise<DanteJournalEvent[]> {
    const response = await fetch('/.netlify/functions/trade-journal', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'PLATFORM_SESSION_EXPIRED' : 'JOURNAL_LOAD_FAILED');
    const result = await response.json();
    return Array.isArray(result.events) ? result.events : [];
}
export async function appendDanteJournalEvent(event: DanteJournalWrite): Promise<void> {
    const response = await fetch('/.netlify/functions/trade-journal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error('JOURNAL_SAVE_FAILED');
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dante:journal-event', { detail: {
            id: Date.now(), bot_key: event.botKey, deriv_account_id: event.derivAccountId || null,
            contract_id: event.contractId || null, event_type: event.eventType, event_data: event.eventData,
            created_at: new Date().toISOString(),
        } }));
    }
}
