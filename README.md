# Dante Builders

Dante Builders is an independent multi-workspace market-technology platform. It has its own identity, navigation, Dante account layer, bot workspaces, activity timeline and journal. Deriv is an external market-data and execution provider connected through its API; Dante Builders is not a Deriv-branded interface.

## Unified bot workspaces

The dashboard presents one bot library backed by shared platform infrastructure, rather than three separate legacy products.

| Workspace | Strategy families | Status |
|---|---|---|
| Parity AI | Even, Odd | Available in shared strategy runtime |
| Flash AI | Digit Matches, Digit Differs | Available in shared strategy runtime |
| Over / Under AI | Digit Over, Digit Under | Available in shared strategy runtime |
| Rise / Fall AI | Rise, Fall | Available in shared strategy runtime |
| Only Up / Only Down AI | Run High, Run Low | Available in shared strategy runtime |
| Asian AI | Asian Up, Asian Down | Available in shared strategy runtime |
| Touch / No Touch AI | Touch, No Touch | In development; execution disabled |
| In / Out AI | In, Out | In development; execution disabled |

The old independent parity/scanner/XML product descriptions are not the current dashboard architecture. Legacy source modules may remain in the repository without being separate top-level products.

## Shared market and trading infrastructure

The implemented strategy runtime includes:

- Deriv-authorized account connection and account selection, including Demo and Real account types supplied by Deriv.
- A configured Volatility market universe, dynamic contract availability discovery through `contracts_for`, and live tick subscriptions.
- Per-symbol quote precision handling, tick buffering and strategy-specific analysis adapters.
- Bounded analysis cycles with tick-count and elapsed-time limits. A cycle that cannot qualify an opportunity is rejected or paused safely rather than analysing indefinitely.
- Proposal and purchase handling behind authorization, account-mode, live-confirmation and risk checks.
- Open-contract monitoring and settlement verification.
- A Dante activity timeline and journal for runtime status, READY / WAIT / REJECTED decisions, purchases and verified settlements.

The dashboard prevents a second active runtime from being started from the same session. Execution safeguards include risk gates and protection against retrying an uncertain purchase. They do not guarantee trading outcomes.

### Strategy limitations

Current strategy adapters use deterministic rules and observed market data. They are not trained machine-learning models; evidence scores are not calibrated probabilities or guarantees about future ticks. Each strategy must pass its own signal, contract and risk gates before a purchase.

Touch / No Touch and In / Out are planned workspaces only. Do not describe them as executable until their adapters, proposal mapping, risk checks and settlement tests are complete.

## Dante activity and journal

The activity timeline presents real engine and trading journal events in Dante Builders terminology. It is not populated with fabricated example trades. Persistent history depends on the backend being configured and verified; local session activity is not a substitute for durable storage.

## Dante account and Deriv account

Users authenticate to Dante Builders separately from connecting a Deriv account. Demo or Real status is determined from the authenticated Deriv account record, not relabelled by the client.

The Dante account service uses Supabase Auth through a Netlify Function and a Secure, HttpOnly, SameSite cookie. The existing Deriv OAuth token handling has **not yet been migrated to a server-side token vault**. Complete and review that security work before production live-trading use.

## Setup and development

This project uses Rsbuild and React Router.

- Node.js 22
- `npm ci`
- `npm run dev` — local development at `http://localhost:4003`
- `npm test -- --runInBand`
- `npm run type-check`
- `npm run build` — production output in `dist/`

## Deriv API configuration

Register a Deriv application and configure its exact redirect URL to match the deployed Dante Builders origin.

Build-time environment variables:

```env
NEXT_PUBLIC_DERIV_APP_ID=your_deriv_app_id
NEXT_PUBLIC_DERIV_ENV=production
NEXT_PUBLIC_DERIV_REFERRAL_LINK=
NEXT_PUBLIC_DERIV_APP_NAME=Dante Builders
```

The Deriv application ID is public configuration. Never place an account token, OAuth access token or private credential in frontend source code. The server-side token-vault work remains a production security requirement.

## Dante registration and Supabase

Before enabling registration on the deployed site:

1. Create a Supabase project.
2. Add GitHub repository secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` (the project reference is configured in the migration workflow).
3. Run **Actions → Apply Supabase database migrations → Run workflow** to apply pending timestamped migrations from `supabase/migrations/`.
4. Add Netlify environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
5. Configure the email confirmation policy in Supabase Auth.
6. Deploy and test signup, email confirmation, login, session refresh and logout.

Until the required Supabase variables are configured, registration is intentionally blocked rather than creating fake local accounts.

Migrations define user-owned profile, bot-configuration, bot-session, trade-event and audit-event tables with row-level security. The frontend account gate establishes the Dante session; bot configuration and event persistence still need to be fully connected to these tables. Verify database policies and account isolation before production use.

## AI Deriv XML generator

The XML generator is a supporting tool, not a substitute for the live strategy runtime. Its current local template supports Even and Odd digit contracts on the configured Volatility market universe. It assembles Trade Parameters, Run Once at Start, Purchase Conditions, Sell Conditions and Restart Trading Conditions, and performs structural validation.

Natural-language interpretation is provided by the Netlify Function at `/.netlify/functions/generate-xml`. Configure these Netlify environment variables for cloud AI interpretation:

- `OPENAI_API_KEY` — private server-side API key.
- `OPENAI_MODEL` — optional model name; currently defaults to `gpt-4o-mini`.

Without the key, the UI uses its local supported generator. Unsupported contract types and instructions should be rejected rather than silently converted. Structural validation is implemented, but a full import and runtime test in the live DBot environment is still required before calling XML import-verified.

## Deployment

Netlify builds `dist/` using `npm run build`; Netlify Functions are served from `netlify/functions`. Commits pushed to `main` trigger production deployment only when the Netlify Git connection is active. Confirm the deployed commit SHA in Netlify before treating a GitHub change as live.

## Production readiness

Before general production use, complete and verify:

- Server-side Deriv OAuth token storage and refresh; no access token exposed to browser storage or logs.
- Supabase migrations, row-level security and user/account isolation tests.
- Durable bot configuration, session and trade-journal persistence.
- End-to-end tests against a Deriv Demo account: account selection, market subscriptions, contract discovery, proposal, purchase, open-contract monitoring and settlement.
- Contract-specific validation and end-to-end tests for every strategy before marking it available.
- DBot import and runtime compatibility tests for generated XML.
- Netlify production deployment verification against the intended Git commit.

A successful CI build confirms only that the configured automated checks pass. It does not prove production services are configured, the latest commit is deployed, or live Deriv trading has been verified.
