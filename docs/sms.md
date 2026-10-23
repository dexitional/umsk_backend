# SMS sending

The shared gateway in `config/sms.ts` uses the [mNotify BMS v2 Quick SMS contract](https://readthedocs.mnotify.com/). It requires `UMS_SMS_KEY` and an approved `UMS_SENDERID` of at most 11 characters. Settings are read when sending and are never included in returned errors.

Run `node scripts/check-sms.cjs` from the backend directory to check credit and sender approval without sending messages. A successful check establishes configuration/account readiness; it does not establish delivery to a handset.

## Behavior

- Ghanaian local, country-code and formatted numbers are normalized centrally. Explicit international numbers are supported. For legacy fields containing slash/comma/semicolon-separated alternatives, the first number is used.
- A submission succeeds only when the gateway returns success code `2000` and reports a positive accepted count without rejected recipients. HTTP 200 by itself is insufficient.
- Requests time out after 15 seconds and are not automatically retried. A timeout may occur after acceptance: check provider reports before resending.
- `sms()` throws a sanitized error on failure. `sms.safe()` returns an explicit `accepted: false` result for notifications attached to already-completed account, payment or other operations. SMS failures must not make completed financial operations look unsuccessful.
- Circulars and calendar reminders await their results, normalize and deduplicate numbers, and return accepted, failed, invalid and duplicate counts. Personalized PIN messages retain separate messages per account. Both use at most five concurrent provider requests per batch.
- Account reset, account/email creation and admission activation report SMS results separately from the main operation. Audit entries record acceptance and campaign IDs where available, without message content or credentials. Self-service password recovery explicitly reports when the password changed but SMS submission could not be confirmed.
- Staff and student account SMS use the actual saved login username and newly generated password. Missing student/staff records are rejected before reset; student staging validates the student and excludes password hashes and unlock PINs from its response. A missing phone or rejected SMS is reported separately from a completed account operation.
- Each newly recorded payment collection API payment sends one receipt to the student's recorded phone, with the amount and bank reference. Document instructions and any newly generated index number are included in that same SMS. Existing transaction references return without resending. `SMS_PAYMENT_RECEIPT` audit entries and the response's `sms` property expose gateway acceptance; SMS rejection does not change the payment's successful status.
- Fresher index eligibility uses the positive amount paid (negating PAYMENT ledger entries) and divides the bill's percentage quota by 100. The index notification is added only when the threshold is met and an index is generated.
- Assessor circulars use assigned staff from the current academic session; debtor circulars use current, non-deferred students with positive outstanding balances.
- Student PIN send endpoints are staff-authorized POST requests at `/api/auth/pins/send` and `/api/auth/pins/send/:tag`. GET requests no longer send messages. Circular sending requires a circular-management role.

The frontend reports gateway acceptance, which is distinct from delivery. Check campaign delivery reports in mNotify for messages accepted but not received. Partial failures are shown as such; retrying an entire batch may resend messages to recipients already accepted.

## Validation

`node --test scripts/test-sms.cjs` uses a mocked HTTP gateway and does not send SMS or consume credits. It covers provider failures inside HTTP 200 responses, HTTP failures, timeouts, normalization, concurrency, circular completion, recipient selection, reminder counts, staff/student staging and reset credentials, missing phones, payment receipts across supported services, duplicate callbacks, index eligibility, audit results and frontend feedback. These tests create no real accounts, password changes or payments.
