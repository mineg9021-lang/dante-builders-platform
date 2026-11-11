import { deleteDerivToken, requireDanteUser } from './_shared/deriv-oauth.mjs';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const cookieName = 'dante_account_session';
const cookieOptions = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const sessionCookie = (session, maxAge = 60 * 60 * 24 * 30) =>
    cookieName + '=' + encodeURIComponent(JSON.stringify(session)) + '; ' + cookieOptions + '; Max-Age=' + maxAge;
const clearCookie = cookieName + '=; ' + cookieOptions + '; Max-Age=0';

const parseSession = request => {
    const raw = request.headers.get('cookie') || '';
    const match = raw.match(new RegExp('(?:^|;\\s*)' + cookieName + '=([^;]+)'));
    if (!match) return null;
    try {
        const value = JSON.parse(decodeURIComponent(match[1]));
        return value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string' ? value : null;
    } catch {
        return null;
    }
};

const getConfig = () => {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_ANON_KEY || '';
    return url && key ? { url, key } : null;
};

const requestSupabase = async (config, path, body, accessToken) => {
    const headers = { apikey: config.key, 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    const response = await fetch(config.url + '/auth/v1/' + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
};

export default async request => {
    const config = getConfig();
    if (!config) return json({ error: 'ACCOUNT_AUTH_NOT_CONFIGURED', message: 'Platform registration is not configured yet. Contact the platform administrator.' }, 503);

    if (request.method === 'GET') {
        const session = parseSession(request);
        if (!session) return json({ authenticated: false }, 401);
        let accessToken = session.access_token;
        let userResponse = await fetch(config.url + '/auth/v1/user', {
            headers: { apikey: config.key, Authorization: 'Bearer ' + accessToken },
        });
        let nextSession = session;
        if (!userResponse.ok && session.refresh_token) {
            const refreshed = await requestSupabase(config, 'token?grant_type=refresh_token', { refresh_token: session.refresh_token });
            if (!refreshed.response.ok || !refreshed.payload.access_token || !refreshed.payload.refresh_token) {
                return json({ authenticated: false }, 401, { 'Set-Cookie': clearCookie });
            }
            nextSession = { access_token: refreshed.payload.access_token, refresh_token: refreshed.payload.refresh_token };
            accessToken = nextSession.access_token;
            userResponse = await fetch(config.url + '/auth/v1/user', {
                headers: { apikey: config.key, Authorization: 'Bearer ' + accessToken },
            });
        }
        if (!userResponse.ok) return json({ authenticated: false }, 401, { 'Set-Cookie': clearCookie });
        const user = await userResponse.json();
        return json({ authenticated: true, user: { id: user.id, email: user.email } }, 200, { 'Set-Cookie': sessionCookie(nextSession) });
    }

    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }

    if (body?.action === 'logout') {
        try {
            const user = await requireDanteUser(request);
            if (user) await deleteDerivToken(user.id);
        } catch {
            // Always clear the Dante browser session even if vault cleanup is unavailable.
        }
        return json({ authenticated: false }, 200, { 'Set-Cookie': clearCookie });
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 256) {
        return json({ error: 'INVALID_CREDENTIALS', message: 'Enter a valid email and a password with at least 8 characters.' }, 400);
    }

    const action = body?.action;
    if (action !== 'signup' && action !== 'login') return json({ error: 'INVALID_ACTION' }, 400);
    const result = action === 'signup'
        ? await requestSupabase(config, 'signup', { email, password })
        : await requestSupabase(config, 'token?grant_type=password', { email, password });

    if (!result.response.ok) {
        const message = action === 'signup'
            ? 'Registration could not be completed. Check the email address or try signing in.'
            : 'Email or password was not accepted.';
        return json({ error: 'AUTHENTICATION_FAILED', message }, result.response.status === 429 ? 429 : 401);
    }

    const session = {
        access_token: result.payload.access_token,
        refresh_token: result.payload.refresh_token,
    };
    if (session.access_token && session.refresh_token) {
        if (action === 'signup') {
            return json({
                authenticated: false,
                registrationComplete: true,
                message: 'Your Dante account was created. Sign in with your new account to continue.',
            });
        }
        return json({ authenticated: true, user: { id: result.payload.user?.id, email: result.payload.user?.email || email } }, 200, {
            'Set-Cookie': sessionCookie(session),
        });
    }
    return json({
        authenticated: false,
        confirmationRequired: action === 'signup',
        message: action === 'signup' ? 'Check your email to confirm the account, then sign in.' : 'Sign in did not return a valid session.',
    }, 200);
};
