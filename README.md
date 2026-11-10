# Dante Builders

Dante Builders is an independent market-technology workspace containing three separate products:

1. **Even/Odd Parity Bot** — live tick sampling, parity analysis, guarded Deriv proposals and purchases, settlement verification, and account-level risk controls.
2. **Digit Intelligence Matches Scanner** — live tick collection, precision-aware final-digit extraction, rolling 0–9 statistics, and Matches/Differs evidence analysis. Scanner mode does not place trades.
3. **AI Deriv XML Bots Generator** — interprets a supported strategy request, assembles XML from DBot block definitions already present in this repository, validates required sections, and exports the XML.

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

## XML Generator AI configuration

The XML generator can assemble and validate the local supported template without a cloud AI key. Natural-language AI interpretation is provided by the Netlify Function at `/.netlify/functions/generate-xml`.

To enable cloud AI interpretation, add these as **Netlify environment variables** (not source-code values):

- `OPENAI_API_KEY` — a private API key for the server-side function.
- `OPENAI_MODEL` — optional; defaults to `gpt-4o-mini`.

After adding or changing these values, trigger a new production deploy. The key is read only by the server-side function and is never exposed to the browser. Without the key, the UI clearly falls back to the verified local generator.

The current verified XML template supports Even and Odd digit contracts on the listed Volatility Index symbols. Other contract types and unsupported strategy instructions are rejected rather than silently converted. Generated XML includes Trade Parameters, Run Once at Start, Purchase Conditions, Sell Conditions, and Restart Trading Conditions.

## Deployment

Netlify builds the `dist` directory using `npm run build`. Commits pushed to the connected `main` branch trigger production deployment when the Netlify Git connection is active. Netlify Functions are served from `netlify/functions`.
