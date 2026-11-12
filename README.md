# ExitForge

ExitForge helps apartment residents book a move that fits the access hours at both buildings. Customers post an inventory and building instructions, movers quote a crew, truck, and schedule, and customers book with a PayPal Sandbox deposit.

[Open the live demo](https://exitforge.site) · [Follow the walkthrough](docs/JUDGING.md) · [Watch the demo video](https://youtu.be/J9ScOkLscDw) · [View the Devpost entry](https://devpost.com/software/exitforge)

## Try the demo

Switch to **Alex Morgan** to post or book a move. Switch to **GoodMove** or **City Crew** to quote and carry out the work. To inspect a completed move, open **Demo · two elevators, one clear plan**, then view its timeline and payment receipt. The walkthrough covers the recorded example and the steps for booking a new move. Use sample data in the shared workspaces and PayPal Sandbox funds at checkout. [Demo walkthrough](docs/JUDGING.md)

## How a move works

1. **Post and confirm access.** OpenAI drafts an editable inventory and access windows from notes and optional images. Customers review the source evidence and confirm the times. Manual entry is available throughout.
2. **Quote and book.** The mover selects a crew and truck. ExitForge checks both buildings' access hours, existing bookings, and the return buffer. Bryntum Scheduler displays the proposed timeline. A verified **20% deposit** confirms the booking.
3. **Handle access changes.** The mover sets a request deadline when quoting, from **1 to 168 hours** before the original loading time. The default is **24 hours**, and the customer sees the deadline before paying. A timely request can be reviewed after the deadline. The mover proposes a new start on the same day for the booked truck and crew, and customer approval triggers a fresh availability check.
4. **Accept and settle.** After the customer accepts the work, they pay the **80% balance** on the site or through a QR checkout link. ExitForge verifies both PayPal captures before the mover can request the crew payout. PayPal Payouts tracks delivery of that separate payment.

The customer can paste a building notice when requesting a schedule change. ExitForge shows the proposed hours alongside the source text and lets the customer confirm them before sending the request.

## Platform fee

New quotes default to a **0.5% platform fee** deducted from the crew payout. The customer pays the quoted total. For a **$180** quote, the customer pays **$36** to book and **$144** after accepting the work. The platform fee is **$0.90**, and the crew payout is **$179.10**, before any separate PayPal fees. The mover sees the amounts before sending the quote.

Set `PLATFORM_FEE_BPS` for new quotes. The default is `50`, which is 0.5%. Each quote records its fee in cents. A schedule change keeps the original quote and payment amounts. Historical quotes without a recorded fee pay the full amount.

## Run locally

Install **Node.js 24 or newer**. From the repository root, run the commands below.

```sh
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). The app seeds fictional jobs and resources in `data/exitforge.sqlite`. Browsing, manual posting, and quoting work without API credentials.

For frontend development, run `npm run dev` and `npm run web` in separate terminals, then open [http://127.0.0.1:4173](http://127.0.0.1:4173). Vite proxies API requests to port 4174. Use `APP_URL=http://127.0.0.1:4173` for PayPal return links in this mode.

## Configure integrations

For a fresh setup, copy [`.env.example`](.env.example) to `.env` using `cp .env.example .env` or `Copy-Item .env.example .env` in PowerShell. Restart the server after changing its environment. Rebuild the frontend after changing a `VITE_*` value.

| Integration | Configuration |
| --- | --- |
| OpenAI | Set `AI_API_KEY` and `AI_MODEL` to use Chat Completions with Structured Outputs. The hosted demo uses `gpt-4.1-mini`. |
| PayPal Orders | Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a Sandbox app. Use a separate [Personal Sandbox buyer account](https://developer.paypal.com/dashboard/accounts) to approve checkout. |
| PayPal Payouts | Configure `PAYPAL_GOODMOVE_RECIPIENT` or `PAYPAL_CITYCREW_RECIPIENT` with the mover's Sandbox Business merchant ID. The sending Sandbox account needs Payouts enabled. |
| Bryntum Scheduler | The Enterprise package runs under Bryntum trial terms. Set `VITE_BRYNTUM_LICENSE_KEY` before building if you have a client license. |

Keep server credentials in the server environment or the ignored `.env`. Vite includes `VITE_*` values in the browser bundle.

## Verify and deploy

```sh
npm test
npm run build
docker build -f deploy/Dockerfile -t exitforge .
```

Automated tests simulate the payment provider and AI responses. They cover scheduling conflicts, request deadlines, verified captures, and crew settlement. The Docker runtime serves port **8000** and exposes `/healthz`. Mount persistent storage at `/data` with write access for the container's `node` user. Set `APP_URL` to the public HTTPS origin, and provide PayPal Sandbox and OpenAI credentials as server environment variables.

The hosted demo uses shared fictional workspaces and PayPal Sandbox test money in USD.

## Project layout

| Path | Purpose |
| --- | --- |
| [`src/`](src/) | React workspaces for posting, quoting, scheduling, and checkout |
| [`server/`](server/) | Express API, SQLite persistence, AI, and PayPal integrations |
| [`shared/`](shared/) | Scheduling, payment state, and draft helpers |
| [`tests/`](tests/) | Automated scheduling, marketplace, and payment checks |
| [`deploy/`](deploy/) | Docker runtime and its locked production dependencies |

The original application uses the [MIT License](LICENSE). See the [third-party notices](THIRD_PARTY_NOTICES.md) for Bryntum and other dependencies.
