# ExitForge

A moving-job marketplace with a hosted Sandbox demo at https://exitforge.site. Customers post a move and confirmed building-access windows. Operators propose a crew, truck, timeline and price. A 20% PayPal Sandbox deposit books the crew. The mover reports completion, the customer accepts the work or requests fixes, and a separately approved 80% Sandbox payment closes the job. Bryntum Scheduler shows resource assignments, task phases and elevator access windows.

## Run

Requires Node.js 24 or newer. Run from this directory.

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Open http://127.0.0.1:4174 . On Windows, use `Copy-Item .env.example .env` only when `.env` does not already exist. Preserve existing integration credentials.

For frontend development, run `npm run dev` and `npm run web` in separate terminals. The Vite UI is on port 4173. Set `APP_URL=http://127.0.0.1:4173` in `.env` for the PayPal return URL in that mode. Restart the API after configuration changes.

## Local identities and data

The default local demo has a customer, GoodMove and City Crew. Use the account switcher to explore each side. Sessions use HTTP-only same-site cookies. Server-side role checks govern posting, offers and reservations. SQLite stores jobs, offers, sessions, resource allocations and payment references in `data/exitforge.sqlite`.

Seed jobs, operators, pricing, durations, travel times and resource availability are illustrative. New posts and offers are persisted. Local startup binds to loopback; the hosted competition demo runs through the existing Cloudflare Tunnel with shared fictional identities and Sandbox payments only. Public identity registration, verified operator onboarding, routing estimates, validated visual volume estimation and live marketplace settlement are pending production capabilities. `DEMO_MODE=false` disables account switching. Real customer use requires replacing shared demo identities with authenticated accounts.

## Integrations

### AI

Configure `AI_API_KEY`, `AI_MODEL` and optionally `AI_BASE_URL`. The verified setup uses the OpenAI API with `gpt-4.1-mini`. The inventory, building notes and up to three optional local images (room, pickup message and destination message; PNG/JPEG/WebP, at most 2 MB each) are sent only when the user clicks Analyze. Addresses are excluded. Original images are not stored with the post. The response uses strict JSON Schema, is checked by Zod, and includes exact source quotations. Text quotations absent from the submitted source are rejected and the affected times are cleared. Mistaken inventory/notes source labels are corrected only when exact text uniquely establishes the actual source. Image readings are attributed to the matching attachment and explicitly require human review. Missing or conflicting access times stay blank. The editable AI item list, handling notes and follow-up questions can be reviewed before posting. The user reviews and confirms the times. A provider assesses actual inventory, loading duration and quoted price.

Jev has been researched as a possible classifier or scorer. It is not integrated. Model confidence is not treated as proof that a moving schedule is correct.

### Bryntum

Uses actual `@bryntum/scheduler-enterprise@8.0.0`, with matching Core styling and fonts. The scheduler displays multi-resource assignments, linked load/travel/wait/unload phases and resource time ranges for building access. Time and availability constraints are also checked server-side. The calendar supports day selection and shows reserved resources. Offer details default to one compact moving-plan lane and two access-window bands, with full numbered steps below. Crew & vehicle mode exposes the individual resource assignments. Dependency connectors are hidden to keep the display readable. Phones use access cards and a vertical step list in the compact view. Offer timelines display a 15-minute return buffer. The calendar is read-only and the offer form provides accessible controls for adjusting the plan. A bounded search returns up to three currently feasible plans while preserving operator-reviewed durations, price and mover count; it can choose other owned trucks/crews. It does not optimize road routes or infer staffing from photos.

The Enterprise dependency runs in trial mode. Obtain appropriate entitlement from Bryntum for the intended usage and demo availability period. The dependency's license remains separate from the application source. Do not copy proprietary vendor source or license keys into a public repository.

Set `VITE_BRYNTUM_LICENSE_KEY` in the ignored `.env` to register an existing Bryntum client license before the first Scheduler is created. Rebuild after changing it. This value is intentionally delivered to the browser by the SDK, including the hosted demo. Keep populated environment files, generated bundles and proprietary package source out of a public source repository. The configured trial expires on December 27, 2026. `VITE_BRYNTUM_PRESENTATION_MODE=true` invokes Bryntum's official `bryntum.demoMode()` once when the Scheduler module loads, hiding the trial badge for one hour during a presentation. It does not extend the trial or grant a production license; the UI footer continues to identify trial usage.

### PayPal

Configure Sandbox `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Credentials stay server-side. All requests are fixed to `api-m.sandbox.paypal.com`. The local configuration page, available only while a required integration secret is absent, saves keys to the ignored `.env` file. Restarting after configuration removes that setup page.

The customer follows an official PayPal Sandbox approval redirect and returns to the app. The backend verifies a completed capture, exact deposit currency/amount and reservation reference. It confirms the booking exactly once. PayPal request IDs stabilize retries. Existing completed payments can be reconciled after a lost response. A payment that completes after reservation expiry is flagged for operator review. The selected operator may confirm the unchanged original plan only after fresh availability and version checks; the action makes no further charge. Changed, unavailable or past plans require customer agreement and manual recovery. A previously completed expired checkout is reconciled before creating another order, preventing a second deposit from being requested silently.

After a verified booking, only the selected mover can start work and report completion. The customer can request fixes; a new completion report is required before acceptance. Explicit acceptance unlocks a separate PayPal order for the exact remaining balance from the immutable quote. Acceptance does not charge the customer. Completed final captures are checked for amount, currency and a distinct final-payment reference; repeated confirmations reuse the verified result. Work closes only after payment verification. An authenticated JSON receipt and chronological work/payment history are available to both parties.

Both customer payments go to the configured platform test merchant. After accepted work and both verified captures, the selected mover can request the full agreed quote through PayPal Sandbox Payouts. Configure a dedicated Sandbox Business recipient merchant ID with `PAYPAL_GOODMOVE_RECIPIENT` or `PAYPAL_CITYCREW_RECIPIENT`. The server fixes the recipient and amount at the first request; one stable batch/item pair survives lost responses and repeated requests. Known batches are checked rather than resubmitted. Only a matching `SUCCESS` item with transaction references marks the crew paid; pending, failed and unclaimed payments remain distinct. Customer payment and crew receipt are separate receipt/UI fields. The demo platform commission is zero, and PayPal fees are separate.

A dedicated GoodMove Sandbox recipient and a complete USD 205 job were verified: USD 41 deposit, USD 164 final payment, then USD 205 received by the mover. The recipient's PayPal transaction detail shows Completed and USD 205 net; repeated payout requests reuse the same batch. See `../.hackathon/evidence/mover-settlement/review.md`. A separate USD 1 capability probe is not a job settlement. A provider's offer remains a local prototype assignment, not a live onboarded PayPal seller. Live seller onboarding, production marketplace approval, paid-booking refunds and operational reconciliation require further work. There is no escrow or real-money transfer.

## Verify

The Payments workspace shows confirmed customer collections, outstanding booked balances and crew settlement separately. Filters and title search open the exact job/receipt. Provider next steps include unpaid crew settlement, and My booked jobs separates assigned work. Once a move is reserved, unrelated movers retain only their own redacted quote/conversation history; the selected crew retains the operational instructions. Booked details put work and payment controls first; the agreed timeline expands on demand.

```sh
npm test
npm run build
```

The current 59 deterministic tests exercise date/access validation, actor permissions, resource overlap, quote invalidation, suggestions, exact deposit cents, idempotent holds/captures, expiry, lost responses, late-payment recovery, AI grounding, fulfillment/acceptance/final payment, receipt downloads, private conversations, unread tracking, quote withdrawal, safe job cancellation, cross-device QR, concurrent checkout, expiry, hosted origin/security controls and AI allowance. Their payment service is an explicit test double. Real OpenAI and PayPal Sandbox results are recorded separately in the event evidence directory. Historical test counts refer to their recorded revisions.

## Core journey

1. As the customer, enter a move in three steps: route/details, inventory/access, then final review. Text drafts are saved in this browser and can be recovered or discarded. Original images remain session-only. Extract access windows with AI or enter them manually, review instructions and confirm before posting.
2. Switch to GoodMove. Open the new move and propose a start time, truck, movers and price. A loading phase outside the pickup window disables submission. Server availability checks reject occupied resources.
3. Return as the customer. Compare offers, reserve a crew and review the ten-minute countdown and exact deposit/balance. An unpaid hold can be released before payment is initiated. Continue to PayPal Sandbox.
4. Approve with a Sandbox Personal test account. The return flow checks the capture and displays the confirmed booking, deposit and remaining balance.
5. Switch to the selected mover. Start move, then submit a completion report. The customer can request fixes before accepting; the mover resolves them and reports again.
6. As the customer, inspect the report, check the acceptance box and accept. Approve the separate remaining balance in PayPal Sandbox. The verified result becomes Completed / Paid in full. Download the JSON payment receipt and inspect activity. Reloading or rechecking does not make another payment.

Customers may edit an unreserved move. Existing offers become outdated until each operator reviews and renews its quote. Held or paid jobs cannot be edited. The workspace refreshes every 15 seconds and on focus, and checks hold expiry immediately with the visible countdown. Expired initiated payments remain available for status recovery. Mobile navigation has visible labels; dialogs support Escape, focus restoration and keyboard interaction.

## Coordinating and managing a move

- Customers can sort offers by total price or finish time. Each offer shows crew/vehicle, scope notes and the 20%/80% split. Booked cards display the agreed total rather than the original budget. Completed bookings show paid status and only the assigned crew in the detail view.
- Each offer has a persistent conversation between its customer and provider. The Messages page and next-step cards show incoming unread messages. Opening a thread marks it read. Conversations refresh every ten seconds while open; workspace summaries refresh every fifteen seconds. Another provider cannot read the thread. Once reserved, only the selected mover's thread stays writable; cancelled jobs retain read-only history. These are local demo messages, not external email/SMS/chat integration.
- A provider can withdraw an unreserved offer and later send a revised quote. Withdrawal survives customer edits; a withdrawn quote cannot be reserved.
- A customer can cancel an unreserved, unpaid post with a reason. The record remains visible. Active holds/paid jobs and any unresolved initiated checkout block this action, preserving payment recovery. This is not a paid-booking cancellation/refund flow.
- Elapsed starts cannot receive a new offer or reservation. Customers can edit open posts to request new dates and quotes. Missing access input returns a validation error instead of a server error.

Keep all API keys, login passwords, SQLite data and local caches out of source control. The `.gitignore` covers these paths. The hosted Sandbox demo is available at https://exitforge.site.

## Final payment QR

After the customer accepts a deposited move, the selected mover can choose **Create payment QR** in its work/payment panel. The QR opens an HTTPS payment page on the customer phone without requiring the desktop identity cookie. It shows only the job title, selected mover, agreed total, paid deposit and exact unpaid USD balance. The link expires after 30 minutes and grants access to this payment only. Only a SHA-256 token hash is stored in SQLite. Share it only with the intended payer.

The phone approves through PayPal Sandbox, then returns directly to the QR page for server verification. A cancelled checkout returns unpaid and reuses the same order. Desktop-created orders retain their original return URL; the same-browser sessionStorage fallback resumes the QR page. A browser that discards site storage or switches browser contexts may need the original QR link again. Provider polling reconciles the existing order every five seconds while the QR panel is open. Exact completed capture, currency and immutable reservation reference are required before marking paid. Desktop and QR checkout share one persisted order and idempotent capture service. Expired links cannot start or capture another payment; already completed captures can still be reconciled.

Customer payments go to the platform test merchant. The existing separate moving-team Payouts flow remains available after full payment. This does not activate live money, verified customer authentication, seller onboarding, escrow or automated refunds.

## Hosted demo operations

See [the judge walkthrough](docs/JUDGING.md) to try the hosted demo. Public API use is bounded to 400 requests per minute per worker. AI use defaults to 30 requests per UTC day, persisted in SQLite, with a 2,000-token output cap per request. This is a usage limit, not a guaranteed monetary spending limit. Manual posting remains available after the AI allowance is exhausted. API/QR pages are not cached, QR pages exclude third-party script/connect destinations, and no-transform disables automatic analytics injection. Production local-setup routes are disabled.
