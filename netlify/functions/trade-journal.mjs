const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const cookieName = 'dante_account_session';
const cookieOptions = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const sessionCookie = session => cookieName + '=' + encodeURIComponent(JSON.stringify(session)) + '; ' + cookieOptions + '; Max-Age=' + (60 * 60 * 24 * 30);
const readSession = request => {
    const raw = request.headers.get('cookie') || '';
    const match = raw.match(new RegExp('(?:^|;\\s*)' + cookieName + '=([^;]+)'));
    if (!match) return null;
    try {
        const value = JSON.parse(decodeURIComponent(match[1]));
        return value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string' ? value : null;
    } catch { return null; }
};
const config = () => {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_ANON_KEY || '';
    return url && key ? { url, key } : null;
};
const allowedBots = new Set([
    'RISE', 'FALL', 'ONLY_UP', 'ONLY_DOWN', 'ASIAN_UP', 'ASIAN_DOWN',
    'DIGIT_MATCH', 'DIGIT_DIFFERS', 'DIGIT_OVER', 'DIGIT_UNDER', 'EVEN', 'ODD',
]);
const allowedContracts = new Set([
    'PUT', 'CALL', 'RUNHIGH', 'RUNLOW', 'ASIANU', 'ASIAND',
    'DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD',
]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cleanEventData = (type, data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const symbol = typeof data.symbol === 'string' && /^[A-Za-z0-9_]{2,30}$/.test(data.symbol) ? data.symbol : undefined;
    if (type === 'DECISION') {
        if (!['READY', 'WAIT', 'REJECTED'].includes(data.decision)) return null;
        return {
            decision: data.decision,
            ...(symbol ? { symbol } : {}),
            ...(allowedContracts.has(data.contractType) ? { contractType: data.contractType } : {}),
            ...(finite(data.evidenceScore) && data.evidenceScore >= 0 && data.evidenceScore <= 100 ? { evidenceScore: data.evidenceScore } : {}),
            ...(Number.isInteger(data.sampleSize) && data.sampleSize >= 0 && data.sampleSize <= 200 ? { sampleSize: data.sampleSize } : {}),
            ...(typeof data.reason === 'string' ? { reason: data.reason.slice(0, 240) } : {}),
        };
    }
    if (type === 'PURCHASED') {
        if (!symbol || !allowedContracts.has(data.contractType) || !finite(data.buyPrice) || data.buyPrice < 0) return null;
        return { symbol, contractType: data.contractType, buyPrice: data.buyPrice };
    }
    if (type === 'SETTLED') {
        if (!['WON', 'LOST', 'VOID'].includes(data.settlement) || !finite(data.profit)) return null;
        return {
            settlement: data.settlement,
            profit: data.profit,
            ...(finite(data.buyPrice) ? { buyPrice: data.buyPrice } : {}),
            ...(Number.isInteger(data.settledAt) ? { settledAt: data.settledAt } : {}),
        };
    }
    if (type === 'RUNTIME_STATUS') {
        if (!['STARTING', 'RUNNING', 'EXECUTING', 'STOPPED', 'PAUSED_ERROR'].includes(data.status)) return null;
        return { status: data.status, ...(typeof data.message === 'string' ? { message: data.message.slice(0, 240) } : {}) };
    }
    return null;
};
const authenticate = async (cfg, session) => {
    const getUser = async token => {
        const response = await fetch(cfg.url + '/auth/v1/user', {
            headers: { apikey: cfg.key, Authorization: 'Bearer ' + token },
        });
        if (!response.ok) return null;
        const user = await response.json();
        return user && typeof user.id === 'string' ? user : null;
    };
    let activeSession = session;
    let user = await getUser(activeSession.access_token);
    let refreshed = false;
    if (!user && activeSession.refresh_token) {
        const response = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: activeSession.refresh_token }),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && typeof payload.access_token === 'string' && typeof payload.refresh_token === 'string') {
            activeSession = { access_token: payload.access_token, refresh_token: payload.refresh_token };
            user = await getUser(activeSession.access_token);
            refreshed = Boolean(user);
        }
    }
    return user ? { user, session: activeSession, refreshed } : null;
};
export default async request => {
    const cfg = config();
    if (!cfg) return json({ error: 'JOURNAL_NOT_CONFIGURED' }, 503);
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const session = readSession(request);
    if (!session) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
    const auth = await authenticate(cfg, session);
    if (!auth) return json({ error: 'SESSION_EXPIRED' }, 401);
    const user = auth.user;
    const refreshHeaders = auth.refreshed ? { 'Set-Cookie': sessionCookie(auth.session) } : {};
    const authHeaders = { apikey: cfg.key, Authorization: 'Bearer ' + auth.session.access_token, 'Content-Type': 'application/json' };
    if (request.method === 'GET') {
        const url = cfg.url + '/rest/v1/dante_trade_events?select=id,bot_key,deriv_account_id,contract_id,event_type,event_data,created_at&order=created_at.desc&limit=50';
        const response = await fetch(url, { headers: authHeaders });
        const payload = await response.json().catch(() => []);
        if (!response.ok) return json({ error: 'JOURNAL_READ_FAILED' }, 502);
        return json({ events: Array.isArray(payload) ? payload : [] }, 200, refreshHeaders);
    }
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 12000) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
    const botKey = typeof body?.botKey === 'string' ? body.botKey : '';
    const eventType = typeof body?.eventType === 'string' ? body.eventType : '';
    const eventData = cleanEventData(eventType, body?.eventData);
    const accountId = typeof body?.derivAccountId === 'string' && /^[A-Z0-9]{5,20}$/.test(body.derivAccountId)
        ? body.derivAccountId : null;
    const contractId = Number.isSafeInteger(body?.contractId) && body.contractId > 0 ? body.contractId : null;
    if (!allowedBots.has(botKey) || !eventData) return json({ error: 'INVALID_TRADE_EVENT' }, 400);
    if ((eventType === 'PURCHASED' || eventType === 'SETTLED') && !contractId) return json({ error: 'CONTRACT_ID_REQUIRED' }, 400);
    const row = {
        user_id: user.id,
        bot_key: botKey,
        deriv_account_id: accountId,
        contract_id: contractId,
        event_type: eventType,
        event_data: eventData,
    };
    const response = await fetch(cfg.url + '/rest/v1/dante_trade_events', {
        method: 'POST',
        headers: { ...authHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
    });
    if (!response.ok) return json({ error: 'JOURNAL_WRITE_FAILED' }, 502);
    return json({ saved: true }, 201, refreshHeaders);
};
