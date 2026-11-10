# Dante Builders

Dante Builders is an independent market-technology workspace containing three separate products:

1. **Even/Odd Parity Bot** — live tick sampling, parity analysis, guarded Deriv proposals and purchases, settlement verification, and account-level risk controls.
2. **Digit Intelligence Matches Scanner** — live tick collection, precision-aware final-digit extraction, rolling 0–9 statistics, and Matches/Differs evidence analysis. Scanner mode does not place trades.
3. **AI Deriv XML Bots Generator** — interprets a supported strategy request, assembles XML using block types defined in this repository, checks all required sections and strategy conditions, and exports the XML. Structural validation is implemented; a full import test in the live DBot environment is still required before calling the output import-verified.

The old general-purpose Blockly bot-builder screen, SmartCharts trading page, Deriv transaction modal, tutorials, and legacy trading dashboard are not part of the Dante product interface. The three products remain independent workspaces.

## Runtime and development

This project uses Rsbuild and React Router.

- Node.js 22
- `npm ci`
- `npm run dev` — local development at `http://localhost:4003`
- `npm test -- --runInBand`
- `npm run type-check`
- `npm run build` — static production output in `dist/`

## Deriv connection

The parity bot requires a Deriv OAuth session to read the account balance, request proposals, purchase contracts, and monitor settlement. The Matches Scanner also uses the Deriv market-data connection. Register a Deriv application and set its exact redirect URL to the deployed site origin.

Build-time environment variables:

```env
NEXT_PUBLIC_DERIV_APP_ID=your_deriv_app_id
NEXT_PUBLIC_DERIV_ENV=production
NEXT_PUBLIC_DERIV_REFERRAL_LINK=
NEXT_PUBLIC_DERIV_APP_NAME=Dante Builders
```

Never place an account token, OAuth access token, or private credential in frontend source code.



## Independent Over 2 bot and shared market universe

The Over 2 workspace is a separate specialist bot. Its strategy engine evaluates a bounded sample, validates source ticks, computes digit metrics, scores the Over 2 evidence and returns READY / WAIT / REJECTED. Its execution adapter discovers `DIGITOVER` through `contracts_for`, requests a one-tick proposal with barrier `2`, buys only after all gates pass, and monitors the returned contract ID to a verified settlement.

The background market universe is the exact 13-symbol set in `src/pages/dashboard/market-universe.ts`: five standard Volatility indices plus the eight available 1-second Volatility indices (including 15, 30 and 90). The list is not shown as a dashboard selector. Parity and Over 2 subscribe to the configured markets and rank eligible samples internally.

The Over 2 pipeline has 18 logical gates and uses `market-metrics-engine.ts` plus `prediction-scoring-engine.ts`. The scoring module is deterministic statistical evidence from historical observations, not a trained machine-learning model and not a calibrated probability of the next tick. No strategy is forced to trade when evidence or safety gates fail. Recovery progression is bounded; the fourth consecutive loss pauses the bot for manual cooldown review.

## Dante platform registration and login

The website now places a separate Dante account registration/login gate in front of the bot library. This is distinct from Deriv OAuth: users first authenticate to Dante, then connect a Deriv account from a bot workspace when trading access is needed.

The account service uses Supabase Auth through a Netlify Function and stores the access/refresh pair in a Secure, HttpOnly, SameSite cookie. The Dante password and platform session are not stored in browser local storage. The existing Deriv OAuth token handling has not yet been migrated to a server-side token vault and must be reviewed before production live-trading use.

Before enabling registration on the deployed site:

1. Create a Supabase project.
2. Apply `supabase/migrations/20261110_dante_platform_schema.sql` in the Supabase SQL editor.
3. Add these Netlify environment variables:
   - `SUPABASE_URL` — the project URL.
   - `SUPABASE_ANON_KEY` — the project's public anon/publishable key.
4. Configure the desired email confirmation policy in Supabase Auth.
5. Trigger a new Netlify production deploy and test signup, email confirmation, login, refresh and logout.

Until those environment variables are configured, the site intentionally blocks account access and reports that registration is not configured; it does not create fake local accounts.

The migration creates user-owned profile, bot-configuration, bot-session, trade-event and audit-event tables with row-level security. The current frontend gate establishes the secure platform session; bot configuration and event persistence still need to be connected to these tables in a later backend phase.

## XML Generator AI configuration

The XML generator can assemble and validate the local supported template without a cloud AI key. Natural-language AI interpretation is provided by the Netlify Function at `/.netlify/functions/generate-xml`.

To enable cloud AI interpretation, add these as **Netlify environment variables** (not source-code values):

- `OPENAI_API_KEY` — a private API key for the server-side function.
- `OPENAI_MODEL` — optional; defaults to `gpt-4o-mini`.

After adding or changing these values, trigger a new production deploy. The key is read only by the server-side function and is never exposed to the browser. Without the key, the UI clearly falls back to the verified local generator.

The current local XML template supports Even and Odd digit contracts on the exact 13-symbol Volatility universe. Unsupported contract types and strategy instructions are rejected rather than silently converted. Generated XML includes populated Trade Parameters, Run Once at Start, digit-based Purchase Conditions, a safe hold-to-expiry Sell Conditions rule, and Restart Trading Conditions. Structural checks are implemented; import into DBot is still required to verify runtime compatibility.

## Deployment

Netlify builds the `dist` directory using `npm run build`. Commits pushed to the connected `main` branch trigger production deployment when the Netlify Git connection is active. Netlify Functions are served from `netlify/functions`.
