const allowedSymbols = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V'];
const allowedContracts = ['DIGITEVEN', 'DIGITODD'];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default async request => {
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'INVALID_JSON' }, 400);
    }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : '';
    const defaults = body?.defaults || {};
    if (!prompt) return json({ error: 'PROMPT_REQUIRED' }, 400);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: 'AI_PROVIDER_NOT_CONFIGURED' }, 503);

    const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            supported: { type: 'boolean' },
            contract: { type: 'string', enum: allowedContracts },
            symbol: { type: 'string', enum: allowedSymbols },
            stake: { type: 'number' },
            duration: { type: 'integer' },
            reason: { type: 'string' },
        },
        required: ['supported', 'contract', 'symbol', 'stake', 'duration', 'reason'],
    };

    try {
        const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: [
                            'You are the configuration interpreter for a Deriv DBot XML generator.',
                            'Return only the requested structured output.',
                            'This verified XML template supports only DIGITEVEN and DIGITODD contracts on the listed Volatility Index symbols.',
                            'If the user requests Matches, Differs, Over/Under, Rise/Fall, martingale, multiple markets, custom code, or any unsupported behavior, set supported=false and explain why in reason.',
                            'Never silently change an unsupported request into another contract.',
                            'For supported requests, interpret contract, symbol, stake and duration from the user prompt; use defaults only when a value is not specified.',
                            'Stake must be greater than zero and no more than 100000. Duration must be an integer from 1 through 10 ticks.',
                            'When unsupported, use safe defaults for the remaining required fields.',
                        ].join(' '),
                    },
                    {
                        role: 'user',
                        content: JSON.stringify({ prompt, defaults }),
                    },
                ],
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'dbot_strategy_config',
                        strict: true,
                        schema,
                    },
                },
                max_tokens: 300,
            }),
        });

        if (!upstream.ok) {
            const detail = await upstream.text();
            console.error('AI provider request failed:', upstream.status, detail.slice(0, 500));
            return json({ error: 'AI_PROVIDER_ERROR', message: 'The AI provider could not process this request.' }, 502);
        }

        const payload = await upstream.json();
        const message = payload?.choices?.[0]?.message;
        if (message?.refusal) return json({ error: 'AI_REFUSED', message: 'The request could not be interpreted.' }, 422);

        let config;
        try {
            config = JSON.parse(message?.content || '');
        } catch {
            return json({ error: 'AI_INVALID_RESPONSE' }, 502);
        }

        if (config.supported !== true) {
            return json({ supported: false, reason: config.reason || 'Unsupported contract or strategy.' });
        }
        if (!allowedContracts.includes(config.contract) || !allowedSymbols.includes(config.symbol)) {
            return json({ error: 'AI_CONFIG_OUT_OF_SCOPE' }, 422);
        }
        if (!Number.isFinite(config.stake) || config.stake <= 0 || config.stake > 100000) {
            return json({ error: 'INVALID_STAKE' }, 422);
        }
        if (!Number.isInteger(config.duration) || config.duration < 1 || config.duration > 10) {
            return json({ error: 'INVALID_DURATION' }, 422);
        }

        return json({
            supported: true,
            contract: config.contract,
            symbol: config.symbol,
            stake: config.stake,
            duration: config.duration,
            reason: config.reason,
        });
    } catch (error) {
        console.error('XML generation AI error:', error);
        return json({ error: 'AI_REQUEST_FAILED', message: 'The AI generation request failed.' }, 502);
    }
};
