# GoMamam report export

## Current portal (verified 7 November 2026)

The signed-in portal is `https://vendor.gomamam.com/`. The previous exporter calls
Ordering.co's `orders.csv` endpoint with an API key. There is no cURL invocation,
mail sender, schedule, or retained artifact in this repository's workflow.

The new portal has two different exports:

- Analytics downloads a multi-section summary CSV. It is not an order ledger.
- Settlements queues an emailed export with a POST to
  `/api/settlements/export?batch_ids=...`. It does not return CSV bytes directly.
  The supplied settlement sample is XLSX with `Merchant Stores` and `Service Jobs` sheets.

The new queue endpoint requires the portal's authentication. Do not send the old
Ordering.co API key to it or treat a queued response as a downloaded report.
Do not trigger it during tests without approval to send a report email.

## Sign in and select settlement batches

Install Node dependencies with `npm ci` and Chromium with
`npx playwright install chromium`. To sign in interactively and preview the
previous complete Monday–Sunday in Asia/Brunei:

```sh
node gomamam-export.js --login --merchant 'Maharani Restaurant (Tanah Jambu)'
```

Add `--channel chrome` to use an already installed Google Chrome instead of
Playwright's bundled Chromium.

The session stays in memory. Add `--save-session` only when you intend to save
the authenticated session locally in `playwright/.auth/gomamam.json` (ignored by
Git and written with owner-only permissions). Never upload this file as an artifact.
Subsequent runs can reuse it. Alternatively supply `GOMAMAM_EMAIL` and
`GOMAMAM_PASSWORD` through a secure environment; these are never logged or saved
by the runner. OTP/CAPTCHA requires interactive sign-in. No password is hardcoded.

For a particular inclusive settlement business-date range:

```sh
node gomamam-export.js --merchant 'Maharani Restaurant (Tanah Jambu)' --from 2026-10-26 --to 2026-11-01
```

This writes `work/gomamam/plan.json` and does not request an email. It discovers
the portal's current `getCanonicalSettlements` Next server action from loaded
scripts, then makes authenticated requests using the browser context's cookie jar.
It follows `next_cursor` until exhausted and rejects out-of-range batches,
repeated cursors, changed response schemas, and an unexpected selected merchant.
This is a private portal interface, not a documented GoMamam public API; changes
to the login, server-action transport or response shape may require maintenance.

The command-line runner requires `--send-email` to request an email. It keeps
local receipts to avoid accidental retries within the same output directory.

Every GitHub workflow invocation now requests a fresh email, including manual
reruns for the same dates. The preview checkbox and cross-run receipt cache have
been removed. Each run/attempt uses an independent receipt directory, so earlier
reports never suppress a new workflow request. An empty date range fails instead
of reporting success without a request. An uncertain request is not retried inside
that invocation; a new workflow invocation is an explicit new request.

Before use, configure GitHub secrets `GOMAMAM_EMAIL`, `GOMAMAM_PASSWORD`, and
the secret `GOMAMAM_MERCHANT`. The merchant label was migrated from the existing
variable to a masked secret when public-log minimization was requested.
No authenticated state, report workbook, or customer data is uploaded as an artifact.

### Public-log minimization

The workflow uses neutral names and a local JavaScript action. Dependency,
browser, test and task output is captured without being printed or
uploaded. Public task output is only completion or a fixed failure code:
E01 (dependency setup), E02 (browser setup), E03 (checks), E05 (task).
Every workflow run requests an email. No receipt cache is restored or uploaded.

This does not anonymize a public repository: GitHub still exposes its owner,
triggering actor, source, commit history and platform-generated checkout/runtime
information. Earlier logs and caches are not deleted. Full troubleshooting
output remains available when running the normal CLI locally.

## Convert an already downloaded settlement

Requires Python 3.9+ and the dependencies in `requirements.txt`:

```sh
python3 -m pip install -r requirements.txt
node export-orders.js --settlement report.xlsx --output orders.csv
```

Set `PYTHON` to a virtual environment's Python executable if needed. Multiple
workbooks can be supplied before `--output`; identical repeated order rows are
deduplicated. Conflicting duplicates, adjustments, unexpected statuses, missing
columns, and invalid dates/amounts stop the export. Existing output files are
never overwritten. No API credentials are needed and no email or Notion calls occur.

Only order references, dates, batch identifiers, service classifications and
amounts are exported. Customer, driver, banking, location and chat data are omitted.

The normalized CSV retains `order_ref` including `GMM-` and leading zeros. Its
numeric suffix is also exposed as `order_id` for MR Online Sales' numeric Order ID
property; `source` is GoMamam. `order_amount` defaults to food `subtotal`, since
MR Online Sales calculates the platform fee separately. `total` (customer charge)
and `merchant_net` remain separate reconciliation columns. An explicit
`--amount-field total` or `--amount-field merchant_net` changes `order_amount`.

## Integration status

Local workbook conversion and the portal export runner are implemented. The
legacy `export-orders.js` default mode remains available explicitly, but the
workflow now uses `gomamam-export.js` and previews unless email is selected.
The email receiver is maintained separately in `emailcsvntn`. Its legacy source-1
CSV parser rejects prefixed IDs, and its Notion writer uses a numeric ID property.
It must consume the normalized fields, preserve the full reference, and deduplicate
by both source and numeric ID before the new files are used for automated imports.

Live interactive sign-in, saved-session reuse, action discovery and read-only
settlement queries passed on 7 November 2026:

- 26 October–1 November: five batches (14, 16, 17, 18, 19).
- 1 November only: batch 19, confirming a same-day inclusive filter.
- 1 January–6 November: all ten available batches, one response page.

Cursor continuation is covered by synthetic tests; the live account did not
have a multi-page result. The merchant-selector regression is tested in a real
headless browser. Nine Node checks and eight workbook-conversion checks passed.

On 8 November, GitHub password-based unattended login and read-only export
planning passed in run 42396428484. Fresh sessions now follow the expired-session
page's sign-in link and wait for login form hydration before filling credentials.
Ten Node checks pass, including the recovery-page regression.

The approved email queue/delivery test and new-workbook email importer remain
unverified. Do not describe the entire
email-to-Notion pipeline as complete. The local session was saved with user
approval, outside Git with owner-only permissions. No account password or GitHub
secret was changed. During the earlier investigation, one portal settlement
Download Report click was attempted before its email-queue behavior was discovered;
email delivery was not confirmed, and the request was not repeated.

## Checks

```sh
python3 -m unittest test_settlement.py
node --check export-orders.js
npm test
```

Tests use synthetic workbooks; private reports must never be committed.
