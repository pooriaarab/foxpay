# Failure modes

This file lists every way foxpay can fail. Each failure mode has a test.
The tests come before the code that makes them pass, so the history proves
the order. Most rows are isolated tests in `tests/`. The `E` rows are Firefox
E2E checks in `e2e/run.mjs`.

No real money moves in any test. The card tests use test card numbers and a
fake card provider. The x402 tests use Base Sepolia values and a local fake
facilitator.

## Words

- **Intent**: one wish to pay, from the planner: merchant, amount, currency,
  reason, method, target, and an idempotency key.
- **Quote**: the amount and the payee that the host reads itself, from the
  merchant page or from the `402` answer. It never comes from the planner.
- **Action**: the foxgate `pay` action that foxpay builds from the quote. The
  human approves this exact action.

## Intents, approvals, and caps

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| I1 | The planner says one amount, and the merchant asks for another. | Refuse `amount-mismatch`. Ask no human. | `tests/intent.test.ts` |
| I2 | The planner says one currency, and the merchant uses another. | Refuse `currency-mismatch`. Never convert. | `tests/intent.test.ts` |
| I3 | The intent currency is not the currency of the spend cap. | foxgate denies `currency`. Nothing pays. | `tests/intent.test.ts` |
| I4 | The amount takes the grant over its spend cap. | foxgate denies `spend-cap` before any approval. The method never runs, so no field is filled. | `tests/intent.test.ts`, E2 |
| I5 | The intent is not valid: an amount that is not a positive whole number, a merchant that is not a host, an empty or long reason, an unknown method, or no idempotency key. | Refuse `bad-intent`. | `tests/intent.test.ts` |
| I6 | The agent retries the same intent with the same idempotency key. | Return the same request, or the same receipt after payment. The method runs one time only. | `tests/intent.test.ts` |
| I7 | The agent sends a different intent with a key that is already used. | Refuse `key-reused`. | `tests/intent.test.ts` |
| I8 | Two `complete` calls for one intent run at the same time. | One pays. The other gets `in-progress` or the receipt. The method runs one time. | `tests/intent.test.ts` |
| I9 | The app stops while a payment runs, so the outcome is not known. | `complete` refuses `outcome-unknown` and never pays again by itself. | `tests/intent.test.ts` |
| I10 | Two intents each fit under the cap, but not together. Both are approved and complete at the same time. | foxgate counts one at a time. One pays, the other gets `spend-cap`. The total spent stays under the cap. | `tests/intent.test.ts` |
| I11 | The token for intent A is used to complete intent B. | foxgate denies `action-changed`. B does not pay. | `tests/intent.test.ts` |
| I12 | The human rejects the request. | Refuse `rejected`. The method never runs. | `tests/intent.test.ts` |
| I13 | The `onEvent` hook throws before a payment. | Refuse `hook-failed`. Nothing pays. | `tests/intent.test.ts` |
| I14 | The approval hides a part of the payment. | The request text names the merchant, the amount, the currency, the reason, the method, and the payee. | `tests/intent.test.ts` |
| I15 | The stored foxpay record is not readable. | Refuse `storage-error`. Nothing pays. | `tests/intent.test.ts` |
| I16 | The amount changes between approval and payment. | The method check before payment sees it and refuses `amount-changed`. foxgate counts no spend. | `tests/intent.test.ts`, C4, X16 |
| I17 | The vault is locked at payment time. | Refuse `locked` before foxgate uses the token. The human can unlock and complete again. | `tests/intent.test.ts`, X12 |
| I19 | A payment method throws while it pays, so foxpay does not know if money moved. | Any error except `PayRefusal` gives `unsettled` with `method-error`. A method throws `PayRefusal` only before any money can move, and that gives `failed`. | `tests/complete.test.ts` |
| I18 | A stored intent is retried after its grant changed to no approval, so it pays with no `complete`. | The method check still runs first, and the payment emits `pay.approved`. | `tests/complete.test.ts` |

## Card fill

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C1 | The tab shows a different merchant than the intent names. | Refuse `merchant-mismatch` at quote time. Nothing is filled. | `tests/card.test.ts` |
| C2 | The tab host looks like the merchant: a changed letter, a Unicode look-alike, or the merchant name inside a longer host. | The host must be equal after punycode. Refuse `merchant-mismatch`. The approval shows the punycode host. | `tests/card.test.ts` |
| C3 | The page changes between approval and payment (a new document in the tab). | Refuse `page-changed`. Nothing is filled. | `tests/card.test.ts` |
| C4 | The checkout total changes after approval. | Refuse `amount-changed` before the fill. The submit step checks the total again in the page. | `tests/card.test.ts` |
| C5 | The card form is inside an iframe. | foxpay fills the top document only, pinned by `documentId`. A field that is only in a frame is not found, and the payment fails with no fill. | `tests/card.test.ts` |
| C6 | The merchant page is plain `http:`. | Refuse `http`, unless the method sets `allowHttp` (demo and tests only). | `tests/card.test.ts` |
| C7 | The stored card does not allow the merchant domain. | foxvault refuses `domain`. Nothing is filled. | `tests/card.test.ts` |
| C8 | The page has no total that foxpay can read. | Refuse `no-total` at quote time. | `tests/card.test.ts` |
| C9 | Card data goes into a receipt, an event, an error, or a return value. | Receipts hold the last 4 digits only. No number, expiry, or CVC goes anywhere else. | `tests/card.test.ts` |
| C11 | The tab loads a new page after the check and before the fill. | foxpay checks the page again before the card number goes out, and refuses `page-changed`. The new page gets nothing. | `tests/card.test.ts` |
| C16 | The tab loads a new page after foxpay's last check and before foxvault fills the number. | foxpay passes the checked `documentId` to `vault.fill`, so foxvault refuses `page-changed` and the new page gets nothing. | `tests/card.test.ts` |
| C12 | Storing the virtual card in the vault fails half way. | foxpay removes every card handle it made. | `tests/card.test.ts` |
| C13 | The submit script starts, and then its result is lost, for example because the page navigates. | The order may be placed, so the status is `unsettled` with `submit-unknown`, never `failed`. | `tests/card.test.ts` |
| C14 | A step after the card number fill fails, so the number stays in the form. | foxpay clears the card fields in the same document before it reports the failure. | `tests/card.test.ts` |
| C15 | A payment with a virtual card fails, and the card stays open at the provider. | foxpay calls `cancelCard` on the provider when the payment is not submitted. | `tests/card.test.ts` |
| C10 | The virtual card provider gets a wrong limit, or a card stays in the vault after use. | The provider gets the approved amount and the merchant. foxpay removes the card handles after the fill, also when the fill fails. A provider error fails the payment with no fill. | `tests/card.test.ts` |

## x402

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| X1 | The `402` asks for another network, for example Base mainnet. | Refuse `requirements-mismatch`. Sign nothing. foxpay accepts Base Sepolia only. | `tests/x402.test.ts` |
| X2 | The `402` asks for another asset. | Refuse `requirements-mismatch`. | `tests/x402.test.ts` |
| X3 | The `402` asks to pay another recipient than the one set for the merchant. | Refuse `requirements-mismatch`. | `tests/x402.test.ts` |
| X4 | The URL or the `402` resource is on another host than the merchant. | Refuse `merchant-mismatch`. | `tests/x402.test.ts` |
| X5 | The `402` header is not valid base64 JSON, or the amount is not a whole number that fits. | Refuse `bad-requirements`. | `tests/x402.test.ts` |
| X6 | The `402` gives another token name or version for the signature domain. | Refuse `requirements-mismatch`. | `tests/x402.test.ts` |
| X7 | The URL answers with no `402`. | Refuse `not-402`. Sign nothing. | `tests/x402.test.ts` |
| X8 | Someone replays a signed payload. | Each payment has a new random 32-byte nonce, and foxpay sends each payload one time. The fake facilitator refuses a used nonce. | `tests/x402.test.ts`, E4 |
| X9 | The facilitator says `success` but gives no settlement: no transaction hash, or another network. | The receipt status is `unsettled`, not `paid`. A `confirm` hook that says no also gives `unsettled`. | `tests/x402.test.ts` |
| X10 | The payee answers with a refusal after it got the signed payment, for example `402` with `insufficient_funds`. | The payee still holds a valid authorization and can settle it until `validBefore`. A refusal is not proof of no payment, so the receipt status is `unsettled` with the payee reason. | `tests/x402.test.ts` |
| X14 | The server answers with an error after it got the signed payment, for example `500` or a `402` with no refusal. | The authorization can still settle, so the receipt status is `unsettled`, not `failed`. | `tests/x402.test.ts` |
| X15 | The URL redirects to another host. | foxpay does not follow redirects, so the signed payload goes to the approved URL only. A redirect is `not-402` at quote time and `unsettled` after payment. | `tests/x402.test.ts` |
| X17 | The answer body fails to read after a `2xx` with a valid settlement. | The settlement header is read first. The receipt status is `paid` with no body. A read error is never `failed`. | `tests/x402.test.ts` |
| X18 | The payee settles the payment and then answers `402` with `success: false`. | The receipt status is `unsettled`, never `failed`. Once the signed payload is sent, x402 never returns `failed`. | `tests/x402.test.ts` |
| X19 | The human approves an x402 payment without seeing which URL it pays for. | The approval names the URL and the 402 resource URL, and the token binds them. | `tests/x402.test.ts` |
| X16 | The price in the `402` changes after approval. | The check before the token fetches the `402` again and refuses `amount-changed`. foxgate counts no spend. | `tests/x402.test.ts` |
| X11 | The wallet key leaks into a log, an event, an error, the store, or the model context. | The key stays in foxvault. foxpay uses it inside `vault.use` only. No output holds it. | `tests/x402.test.ts` |
| X12 | The vault is locked. | Refuse `locked` before the token is used. | `tests/x402.test.ts` |
| X13 | The signature is wrong, so a real facilitator would refuse it. | The EIP-712 digest and the signature are equal to those from viem. The signer address recovers. | `tests/eip712.test.ts` |

## Firefox E2E

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| E1 | A shop order under the cap does not reach the shop, or reaches it with wrong data. | One approval. foxpay fills the card and submits. The foxbench server sees one order with the right total and card last 4. | `e2e/run.mjs` |
| E2 | An order over the cap fills the card. | foxpay refuses before any fill. The card fields stay empty, and the shop has no order. | `e2e/run.mjs` |
| E3 | An x402 call pays more than one time, or with no approval. | It pays one time, after one approval. The fake API settles one payment. | `e2e/run.mjs` |
| E4 | A replayed payment header pays again. | The fake API refuses it. A second `complete` gives the same receipt. | `e2e/run.mjs` |
| E5 | The popup shows a wrong budget. | The popup shows the cap, the amount left, the waiting approvals, and the receipts. | `e2e/run.mjs` |
| E6 | The card number or the wallet key leaks into the popup or `storage.local`. | Neither holds any of them. | `e2e/run.mjs` |
