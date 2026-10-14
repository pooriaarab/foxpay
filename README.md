# foxpay-agent

[![npm version](https://img.shields.io/npm/v/foxpay-agent)](https://www.npmjs.com/package/foxpay-agent)
[![Downloads/month](https://img.shields.io/npm/dm/foxpay-agent)](https://www.npmjs.com/package/foxpay-agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)
[![Types included](https://img.shields.io/badge/types-included-blue)](#runtime-surfaces)

[Setup](#install) · [Quickstart](#complete-your-first-test-payment) · [API reference](#runtime-surfaces) · [Comparisons](#compare)

foxpay-agent is an open-source payment orchestration library for developers who build browser agents and paid API clients.
It checks host-read quotes against payment intents, uses foxgate spend controls, and records receipts.
It ships card-fill and x402 methods; x402 supports Base Sepolia test USDC only.

## Install

```bash
npm i foxpay-agent foxgate foxvault
```

The package declares Node.js 24+ and includes TypeScript declarations.
It has four direct runtime dependencies: foxgate, foxvault, @noble/curves, and @noble/hashes.

## Complete your first test payment

Save this as `pay.mjs` and run `node pay.mjs` after installation.
It calls an in-memory fake API. No environment variables, `.env` file, funded wallet, or chain connection are needed.
The automatic approval below is for this test fixture. Production hosts must show the action to a person.

```js
import { createFoxgate, memoryStore } from "foxgate";
import { createVault } from "foxvault";
import { PAY_TOOL, createFoxpay, payTools, x402 } from "foxpay-agent";
import { fakeX402Api } from "foxpay-agent/testing";

// A Base Sepolia test key and recipient. The fake API stands in for a paid API.
const WALLET_KEY = "0x" + "1".repeat(64);
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const store = memoryStore();
const { gate, host } = createFoxgate({ tools: payTools(), store });
// A cap of 0.05 test USDC. foxgate counts test USDC as XTS, in atomic units.
await host.addGrant({ scope: "pay", domains: ["api.example"], tools: [PAY_TOOL], spendCap: { value: 50_000, currency: "XTS" } });

const vault = createVault();
await vault.initialize();
await vault.set("vault:wallet", WALLET_KEY, { domains: ["api.example"] });

const api = fakeX402Api({ host: "api.example", payTo: PAY_TO, price: 10_000, body: "sunny" });
const method = x402({ vault, wallet: "vault:wallet", payTo: { "api.example": PAY_TO }, fetch: api.fetch });
const pay = createFoxpay({ gate, store, methods: { x402: method } });

const asked = await pay.request({
  merchant: "api.example",
  amount: 10_000, // 0.01 test USDC
  currency: "USDC",
  reason: "Weather data, one call",
  method: "x402",
  idempotencyKey: "call-0001",
  target: { url: "https://api.example/weather" },
});
console.log(asked.status); // ask
if (asked.status !== "ask") throw new Error(`Expected approval request: ${asked.status}`);

const [request] = await host.pending();
console.log(request.text); // the exact action that the human approves

const done = await pay.complete(asked.id, await host.approve(asked.requestId));
console.log(done.status, done.body); // paid sunny
const again = await pay.request({ merchant: "api.example", amount: 10_000, currency: "USDC", reason: "Weather data, one call", method: "x402", idempotencyKey: "call-0001", target: { url: "https://api.example/weather" } });
console.log(again.status, api.settled.length); // paid 1
```

Success prints `ask`, the approval text, `paid sunny`, and `paid 1`. The last value confirms one fake settlement.
Never fund the public fixture key. It is not a private wallet.

## How it works

```text
Intent -> host-read quote -> amount/currency match -> foxgate spend check
       -> approval when the grant requires it -> method recheck -> payment
       -> stored receipt: paid | submitted | unsettled | failed
```

The store binds each idempotency key to one intent. Changed intents using that key are refused.
A grant can allow a payment without a prompt; configure foxgate for per-payment approval when needed.
The method rechecks a pending payment before token redemption. Spend is counted when foxgate authorizes it.
An interrupted payment remains `outcome-unknown` rather than being paid again.

## Why it exists

[Stripe Checkout](https://docs.stripe.com/payments/checkout) provides merchant payment pages.
[The x402 client](https://docs.x402.org/getting-started/quickstart-for-buyers) handles paid HTTP requests.
foxpay-agent adds intent matching, host spend controls, approvals, and stored outcomes around its payment methods.
It does not replace a card processor or an on-chain facilitator.

## Compare

Scope checked on 2026-10-14 against the linked official documentation. This table compares roles, not fees or payment guarantees.

| Item | foxpay-agent | [x402 client](https://docs.x402.org/getting-started/quickstart-for-buyers) | [Stripe Checkout](https://docs.stripe.com/payments/checkout) |
|---|---|---|---|
| Scope | Agent payment orchestration | Paid HTTP client | Merchant checkout |
| Deployment | Your trusted host | Your API client | Hosted or embedded payment page |
| Configuration | Gate, vault, methods, store | Wallet and payment client | Server-created Checkout Session |
| Shipped path | Card fill; Base Sepolia x402 | HTTP 402 protocol | Stripe payment processing |

## Coverage

| Method or service | Status | Verification |
|---|---|---|
| Firefox top-document card fill | ✓ | Test checkout and fake card provider |
| x402 v2 exact scheme, Base Sepolia test USDC | ✓ | Fake facilitator; real chain pending |
| Mainnet x402 | — | No network option |
| Stripe Issuing / Privacy.com virtual cards | — | Provider interface only; no adapter ships |
| Hosted card fields in iframes | — | Unsupported |

Two payment methods ship. Zero real card providers and zero live facilitators are credential-checked by the repository tests.
The fake x402 API verifies signatures locally. Its transaction hashes are fixtures, not chain confirmations.

## Common use cases

1. Firefox agent authors: approve a test-card checkout through foxgate before foxvault fills fields.
2. Node.js tool authors: exercise a paid x402 API against `fakeX402Api` without a funded wallet.
3. QA engineers: use a foxbench test checkout to check spend caps and changed totals.
4. Agent framework authors: expose `request` and `complete` while the host owns approval and wallet keys.
5. Audit tool authors: pass foxtrail-compatible `onEvent` hooks to record intents and receipts.

## Features

- **Intent matching:** compare merchant quotes with exact amount and currency; see [the API](#runtime-surfaces).
- **Spend controls:** register `payTools()` with foxgate and configure grants.
- **Idempotency:** return stored receipts for completed intents using the same key.
- **Card fill:** pin operations to the checked document; see [cardFill](#cardfilloptions).
- **x402 signing:** sign EIP-3009 authorizations using EIP-712 typed data; see [x402](#x402options).
- **Test API:** simulate requirements, signature checks, and settlement failures through the testing subpath.

## Runtime surfaces

The package exports a library and a testing subpath. It has no command-line interface (CLI) or Model Context Protocol (MCP) server.
The x402 method runs in Node.js or trusted browser code. Card fill requires Firefox extension APIs.

### `createFoxpay(options)`

| Option | What it does |
|---|---|
| `gate` | A foxgate gate made with `createFoxgate({ tools: payTools() })`. Add `[FILL_TOOL]: "fill"` for card fill. |
| `methods` | `{ name: PayMethod }`, for example `{ card: cardFill(...), x402: x402(...) }`. |
| `store` | Where intents and receipts live. Use the same store as foxgate, for example `storageAreaStore(browser.storage.local)`. |
| `onEvent` | `(event) => void \| Promise<void>`. Gets `{ actor: "foxpay", kind, data }`, which fits foxtrail `log.append`. If it throws before a payment, the payment stops with `hook-failed`. |
| `now` | The clock, in ms. Default: `Date.now`. |

| Method | What it does |
|---|---|
| `request(intent)` | Checks and quotes the intent and asks foxgate. Returns `{ status: "ask", id, requestId }`, `{ status: "refused", reason, message }`, or a final result when the intent was already paid or the grant needs no approval. |
| `complete(id, token)` | Pays an approved intent with the foxgate token. Returns `{ status, id, receipt, body? }` or a refusal. Later calls give the same receipt. |
| `intents()` | Every stored intent with its status. |
| `receipts()` | Every receipt, oldest first. |

An intent is `{ merchant, amount, currency, reason, method, idempotencyKey, target? }`.
`amount` is whole minor units: cents for USD, atomic units (6 decimals) for
USDC. `reason` has 1 to 200 characters. `idempotencyKey` has 8 to 128.
`target` is `{ tabId }` for card fill and `{ url }` for x402.

A receipt holds the merchant, the amount, the currency, the reason, the
method, the payee, the status, the request id, the time, and a `proof`. The
proof holds only public data: the last 4 card digits, the card handle or the
provider card id, the page after submit, or the payer, the nonce, the network,
and the transaction hash.

Statuses: `paid` (x402 with a settlement), `submitted` (card checkout
submitted), `unsettled` (no settlement proof; money may have moved), and
`failed` (foxpay knows that nothing was paid).

Refusal reasons: `bad-intent`, `key-reused`, `amount-mismatch`,
`currency-mismatch`, `in-progress`, `outcome-unknown`, `not-found`,
`hook-failed`, `storage-error`, `method-error`, every foxgate deny reason
(for example `spend-cap`, `currency`, `rejected`, `token-used`), and the
method reasons below.

### `cardFill(options)`

| Option | What it does |
|---|---|
| `vault`, `browser` | A foxvault vault (with a gate that has a `fill` grant for the merchant) and the WebExtension `browser` object. foxpay pins every fill, also the foxvault one, to the `documentId` that it checked. Needs a foxvault with the `documentId` fill option. |
| `card` | `{ number, details }`: the handle of the card number and the handle of `"MM/YY CVC"`. |
| `provider` | Or a `VirtualCardProvider` with `createCard({ intentId, merchant, amount })` that returns `{ id, number, exp, cvc }`, and an optional `cancelCard(id)` that foxpay calls when the payment fails before submit. |
| `fields` | `{ number, exp, cvc }`: CSS selectors in the checkout page. |
| `total`, `submit` | The selector of the total text and of the pay button. |
| `currency` | The merchant currency. foxpay never reads it from the page. |
| `decimals` | Default: 2. |
| `allowHttp` | Allow plain `http:` pages. For local tests only. |
| `waitMs` | How long to wait for the page after submit. Default: 10 seconds. |

Reasons: `bad-target`, `no-tab`, `http`, `merchant-mismatch`, `page-changed`,
`amount-changed`, `no-total`, `no-card`, `domain`, `locked`,
`provider-error`, `not-found`, and every foxvault fill reason. When a step
fails after the number fill, foxpay clears the card fields first. When the
submit script starts but its result is lost, the status is `unsettled` with
`submit-unknown`, because the order may be placed.

### `x402(options)`

| Option | What it does |
|---|---|
| `vault`, `wallet` | The vault and the handle of a Base Sepolia test wallet key (0x and 64 hex digits). |
| `payTo` | `{ host: address }`: the recipient that each merchant must name. |
| `fetch` | Default: the global `fetch`. |
| `confirm` | `(settlement) => Promise<boolean>`. Check the transaction yourself, for example on an RPC node. When it says no, the receipt is `unsettled`. |
| `maxTimeoutSeconds` | The longest time a signed authorization stays valid. Default: 300. |

Reasons before the payment: `bad-target`, `merchant-mismatch`,
`no-recipient`, `no-wallet`, `not-402`, `bad-requirements`,
`requirements-mismatch`, `amount-changed`, `locked`, and `sign-error`
(status `failed`). foxpay does not follow redirects.

After foxpay sends the signed payload, the payee holds a valid authorization
until `validBefore`. So x402 never returns `failed` after that point. The
status is `paid` with a settlement, or else `unsettled` with a reason:
`no-response`, `read-error`, `no-settlement`, `not-confirmed`,
`http-<status>`, or the payee's `errorReason`. A payee refusal is not proof
that no money moved. Check an `unsettled` payment on the chain before you
pay again.

### Write your own method

A `PayMethod` has `quote(intent)`, an optional `check(context)`, and
`pay(context)`.

- `quote` reads the amount and the payee on the host side. Throw
  `PayRefusal` to refuse. Nothing has been approved yet.
- `check` runs before foxgate uses the token. Return a reason, for example
  `amount-changed` or `locked`, to stop with no spend.
- `pay` returns `{ status, reason?, proof?, body? }`. Return `failed` only
  when you know that no money moved. When you do not know, return
  `unsettled`.
- From `pay`, throw `PayRefusal` only before any money can move. foxpay
  records it as `failed` with its reason. foxpay records any other error
  from `pay` as `unsettled` with `method-error`, because it can come after
  money moved. The error message is not kept.



| Export | What it does |
|---|---|
| `payTools()`, `PAY_TOOL` | The foxgate tool registry entry `foxpay.pay`, with an amount function that reads the quoted amount. |
| `GATE_CURRENCY` | `{ USDC: "XTS" }`. foxgate takes 3-letter codes, so test USDC counts as XTS, the ISO 4217 code for tests. |
| `PayRefusal` | Throw it from your own `PayMethod` to refuse with a reason. See "Write your own method". |
| `BASE_SEPOLIA` | The network, chain id, USDC contract, and token domain that x402 accepts. |
| `encodeHeader`, `decodeHeader` | Base64 JSON for the x402 headers. |
| `signAuthorization`, `recoverAuthorizer`, `authorizationDigest`, `addressOf`, `checksumAddress` | The EIP-712 and EIP-3009 helpers. |
| `foxpay-agent/testing`: `fakeX402Api(options)` | A fake paid API with a local fake facilitator. It checks the signature and refuses a used nonce. For tests and demos only. |

## Delivery/behavior limits

- x402 pays on Base Sepolia only. The network and the USDC contract are
  fixed in the code. There is no mainnet option.
- foxpay was tested with its own fake facilitator only. It follows the x402
  version 2 HTTP headers, but no test ran against the public x402.org
  facilitator or a real chain.
- There is no real virtual card provider yet. `VirtualCardProvider` is the
  interface for one, such as Stripe Issuing or Privacy.com. The tests use a
  fake provider.
- Card fill works in the top document only. A card form inside an iframe,
  for example a hosted payment field, cannot be filled.
- A card payment ends as `submitted`. foxpay sees the page after submit, not
  the charge. The total is what the merchant page shows.
- Each merchant needs its own selectors for the card fields, the total, and
  the pay button.
- foxvault values need 8 characters or more, so the expiry and the CVC are
  one secret, `"MM/YY CVC"`. foxpay fills them through `vault.use` with its
  own bundled function, pinned to the same document. `redact` finds that
  pair, not the CVC alone.
- foxgate counts the spend when the token is used. A payment that fails
  after that still counts against the cap. Before the token, foxpay checks
  the page total or fetches the `402` again, so a changed price is refused
  with no spend.
- `outcome-unknown` needs a person. foxpay does not check with the merchant
  or the chain if an interrupted payment went through.
- Run one foxpay object, one foxgate gate, and one vault for each store, in
  the background page. Two objects on the same store can race.
- foxpay-agent supplies payment orchestration. It does not supply a payment processor, card issuer, managed wallet, or legal advice.
## Integration guides

- [Node.js x402 fixture quickstart](#complete-your-first-test-payment)
- [Firefox checkout demo and E2E checks](#demo-extension)
- [Custom payment method contract](#write-your-own-method)

### Demo extension

`extension/` is a demo for Firefox 153+. The popup shows the spend caps and
what is left, the payments that wait for approval with their exact action
JSON, and the receipts. A simulated agent pays for a
[foxbench](https://github.com/pooriaarab/foxbench) Trailhead Supply checkout
with a test card, or calls a local fake x402 API.

```bash
pnpm install
pnpm e2e        # builds, loads the demo in Firefox, and runs the E2E checks
pnpm build:ext  # builds dist-ext/; load it from about:debugging
```

`pnpm e2e` writes `artifacts/e2e-<date>.json`. It checks a $26.00 order under
a $100 cap with one approval (the foxbench server sees the order and card
ending 4242), a $500 order that is refused before any fill, and an x402 call
that pays one time while a replay is refused.


## Status

The package version is 0.1.4. The 0.x API can change.
[GitHub issues](https://github.com/pooriaarab/foxpay/issues) are the support channel.
Public case studies are not yet published. Repository examples use test cards and a fake facilitator.

## FAQ

### What is foxpay-agent?

foxpay-agent is a payment orchestration library with intents, spend checks, and receipts. Hosts configure the gate, secrets, store, and methods.

### Which integrations are verified?

foxpay-agent tests card fill against a demo checkout and x402 against a fake facilitator. No real card provider or live chain is verified.

### Does foxpay-agent provide a managed payment service?

foxpay-agent runs in your trusted process. It provides no managed wallet, card issuer, or payment processor.

### How is foxpay-agent different from the x402 client?

foxpay-agent adds host spend checks and stored intents around payment methods. Its x402 method is limited to Base Sepolia; see the [comparison](#compare).

### How is foxpay-agent different from Stripe Checkout?

foxpay-agent coordinates agent-side payment requests. Stripe Checkout supplies merchant payment pages and processing; see the [comparison](#compare).

### Does every payment require human approval?

foxpay-agent follows foxgate grants, which can allow a payment without a prompt. Configure approval-required grants and keep approval tokens in host-controlled code.

### Can foxpay-agent pay on mainnet?

foxpay-agent fixes its x402 network and token to Base Sepolia test USDC. It has no mainnet option.

### Does submitted mean a card charge succeeded?

foxpay-agent uses `submitted` when it submits the checkout form. It cannot verify the card charge or merchant settlement.

### What should I do with an unsettled receipt?

foxpay-agent treats `unsettled` as an unknown payment outcome. Check with the merchant or chain before starting another intent.

## License

[MIT](https://opensource.org/license/mit)
