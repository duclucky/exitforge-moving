# ExitForge

ExitForge is a marketplace for apartment moves. Customers turn inventory and building access instructions into a move request. Movers propose a crew, truck, schedule, and price that fit both buildings. Customers reserve the crew with a PayPal Sandbox deposit and pay the remaining balance after accepting the work.

[Try the hosted demo](https://exitforge.site) · [Follow the walkthrough](docs/JUDGING.md) · [Watch the demo video](https://youtu.be/J9ScOkLscDw) · [View the Devpost entry](https://devpost.com/software/exitforge)

## Run locally

Install Node.js 24 or newer, then run these commands from the repository root.

```sh
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). Choose **Alex Morgan** to post or book a move, or **GoodMove** or **City Crew** to send an offer. The app seeds fictional jobs and resources in `data/exitforge.sqlite`. You can browse, post manually, and quote without API credentials.

For frontend development, run `npm run dev` and `npm run web` in separate terminals. Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Vite proxies API requests to port 4174. Set `APP_URL=http://127.0.0.1:4173` for PayPal returns in this mode.

## Configure integrations

For a fresh setup, run `cp .env.example .env` or `Copy-Item .env.example .env` in PowerShell. Update your existing `.env` directly if you already have one. Restart the server after editing it. Rebuild the frontend after changing a `VITE_*` value.

| Integration | Local configuration |
| --- | --- |
| OpenAI | Set `AI_API_KEY` and `AI_MODEL=gpt-4.1-mini`. The example uses the OpenAI API base URL. |
| PayPal Orders | Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a PayPal Sandbox app. Use a separate [Personal Sandbox buyer](https://developer.paypal.com/dashboard/accounts) to approve checkout. |
| PayPal Payouts | Set `PAYPAL_GOODMOVE_RECIPIENT` or `PAYPAL_CITYCREW_RECIPIENT` to the matching Sandbox Business account's merchant ID. The sending Sandbox account must support Payouts. |
| Bryntum Scheduler | The Enterprise package runs under Bryntum trial terms. If you have an applicable client license, set `VITE_BRYNTUM_LICENSE_KEY` before building. |

Store API secrets in the server environment or the ignored `.env`. Vite embeds `VITE_*` values in the client bundle.

### How the integrations work

- **OpenAI Chat Completions with Structured Outputs** drafts an editable inventory and pickup/drop-off access windows from notes and optional images. ExitForge validates the structured response and its text evidence, and the customer confirms the details before posting. Manual entry is available when AI is unavailable.
- **Bryntum Scheduler Enterprise 8** visualizes truck and crew assignments, moving phases, and elevator access windows. The server checks availability and building constraints when generating plans, publishing quotes, and reserving resources.
- **PayPal Orders** collects a 20% deposit to book the crew. Customer acceptance unlocks a separate order for the 80% balance. The mover can create a time-limited QR checkout link for the customer to open on a phone. The server verifies completed captures and reconciles retries against the same orders.
- **PayPal Payouts** tracks the crew's settlement separately after both captures have been verified. The crew is marked paid once PayPal confirms the matching payout item succeeded.

## Schedule changes

- Before deposit, **Find available plans** explains access and crew conflicts and previews a possible extension of the building hours. Confirm any new hours before sending the quote.
- After deposit, the customer can report confirmed changes to the building hours before work starts. The assigned mover proposes a new start on the same date. Customer approval checks the original crew and truck again and updates their allocations. The quote, deposit, and remaining balance stay attached to the original booking.

When building access changes after booking, the customer can paste a notice, review the quoted text, and apply the detected hours before confirming. The mover can search for available starts using the originally booked truck and crew.

Movers choose a 1 to 168 hour minimum notice when quoting, with 24 hours as the default. Customers see the deadline before paying a deposit. The deadline is based on the original booked start. A request submitted in time can still be reviewed afterward.

## Platform fee

New quotes default to a 0.5% platform fee. Set `PLATFORM_FEE_BPS` to change the rate for new quotes. The fee is deducted from the crew payout, and the customer pays the quoted total. Quotes record the fee in cents. Historical quotes without a recorded fee pay the full amount.

## Project layout

| Path | Purpose |
| --- | --- |
| [`src/`](src/) | React workspaces for posting, quoting, scheduling, and checkout |
| [`server/`](server/) | Express API, SQLite persistence, AI, and PayPal integrations |
| [`shared/`](shared/) | Scheduling, payment state, and draft helpers |
| [`tests/`](tests/) | Automated scheduling, marketplace, and payment checks |
| [`deploy/`](deploy/) | Docker runtime and its locked production dependencies |

## Verify

```sh
npm test
npm run build
```

Automated tests use simulated payment responses. The [hosted walkthrough](docs/JUDGING.md) covers the verified Sandbox deposit, QR payment, and mover payout.

## Deployment and demo scope

Build the frontend before building the runtime image from the repository root.

```sh
npm run build
docker build -f deploy/Dockerfile -t exitforge .
```

The container listens on port 8000 and serves `/healthz`. Mount writable persistent storage at `/data` for the container's non-root user. For a hosted demo, pass runtime credentials through the container environment and set `APP_URL` to the public HTTPS origin behind your reverse proxy.

The hosted app uses shared fictional workspaces and PayPal Sandbox test money in USD. Production use requires real customer authentication, operator onboarding, and a live settlement and refund workflow. Use sample data in the shared demo.

## License

The original application is [MIT licensed](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Bryntum and other dependencies.
