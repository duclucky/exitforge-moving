# Test ExitForge

Open https://exitforge.site. The hosted demo uses shared fictional workspaces. Use the account switcher to choose Alex Morgan (customer), GoodMove (mover), or City Crew (another mover). Enter only sample details. The application operates in USD with PayPal Sandbox.

## Inspect the recorded demo job

1. In the customer workspace, open **Demo · two elevators, one clear plan** and view its receipt. It shows a $36 deposit, a $144 final payment, and a $0 customer balance.
2. Expand **View the agreed moving timeline** and switch between **Move plan** and **Crew & vehicle**. Check the pickup access from 09:00 to 09:45, the drop-off access from 11:00 to 12:00, and the return buffer.
3. Switch to GoodMove, open **Payments**, and search for the same job. **Crew payment received** records the separate $180 Sandbox payout.

## Try a new move

1. Post a move for a future date. Use synthetic locations and an inventory such as “12 packed boxes, 1 wooden desk, 2 chairs and 1 bookshelf.” Enter “Pickup service elevator available 09:00–09:45. Destination service elevator available 11:00–12:00.” Choose **Analyze move details**, inspect the quoted evidence and confirm both windows before posting. Manual entry is available if the shared demo's AI allowance is exhausted.
2. Switch to GoodMove. Open the new job, set a $180 quote, and choose a truck and crew. A 60-minute load from 09:00 exceeds the pickup window. Try the 30-minute example load with 45 minutes of travel and 60 minutes of unloading. Choose **Find available plans**, review the result, and send the offer.
3. Switch to Alex Morgan and choose the crew. ExitForge holds the selected resources for ten minutes. Continue to PayPal Sandbox and use a PayPal Sandbox buyer account to approve the $36 test deposit. If access is needed, create a free Personal Sandbox account in the [PayPal Developer Sandbox Accounts dashboard](https://developer.paypal.com/dashboard/accounts). The recorded demo job and its receipts can be inspected without a Sandbox login.
4. Switch to GoodMove, start the job, and write a fictional completion report. Switch back to Alex, review it, and accept. The remaining $144 becomes payable.
5. As GoodMove, select **Create payment QR**. Open the link on a separate device or in a browser without the workspace session. Approve through PayPal Sandbox. After capture, the payment page and mover workspace show $0 outstanding. The same order is reused when checkout is retried.
6. For a GoodMove job with both captures verified, use **Receive Sandbox payment**, then check the batch. The crew is credited only after PayPal confirms the payout item succeeded.

The hosted demo already has the AI and merchant integrations configured. Use the repository README if you want to run your own copy. Please use test funds and sample data throughout.
