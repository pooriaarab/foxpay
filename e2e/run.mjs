// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, pay through its popup, and write artifacts/e2e-<date>.json. It
// checks failure modes E1-E6 in docs/failure-modes.md.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
//
// The shop is the foxbench Trailhead Supply site on shop.localhost. Firefox
// sends *.localhost to the loopback address. The card is a test card; no
// money moves. The paid API is a local fake x402 API on api.localhost, with
// a test wallet key and Base Sepolia values.
import { launch, poll, writeArtifact } from "create-foxkit/e2e";
import { sites, startServer } from "foxbench";
import { addressOf } from "../dist/index.js";
import { startX402Api } from "./x402-api.mjs";

const CARD = { number: "4242424242424242", exp: "12/30", cvc: "737" };
// A throwaway test key. It is only valid for the fake API and holds nothing.
const WALLET = "0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });

// Click a button, wait until the output counts one more answer, and return it.
async function press(page, button, output) {
  const before = await page.evaluate((o) => Number(document.querySelector(o).dataset.runs ?? 0), output);
  await page.evaluate((b) => document.querySelector(b).click(), button);
  await poll(page, ([o, b]) => Number(document.querySelector(o).dataset.runs ?? 0) > b, [output, before]);
  return page.evaluate((o) => document.querySelector(o).textContent, output);
}
const setValues = (page, values) =>
  page.evaluate((v) => {
    for (const [selector, value] of Object.entries(v)) document.querySelector(selector).value = value;
  }, values);
const texts = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.textContent.replace(/\s+/g, " ").trim()), selector);

const shopServer = await startServer({ sites });
const paid = await startX402Api({ payTo: PAY_TO, price: 10_000, body: '{"forecast":"sunny"}' });
const signed = () => paid.api.log.filter((l) => l.payment !== null);
const SHOP = shopServer.url.replace("127.0.0.1", "shop.localhost");
const addToCart = (form) => fetch(`${shopServer.url}/shop/cart/add`, { method: "POST", body: new URLSearchParams(form), redirect: "manual" });
// The agent fills the shipping part. foxpay fills only the card.
async function openCheckout() {
  const page = await fox.open(`${SHOP}/shop/checkout`);
  await setValues(page, { "#email": "ada@example.com", "#name": "Ada Lovelace", "#address": "12 Analytical Way", "#city": "London", "#postal": "N1 7AA" });
  return page;
}
const cardValue = (page) => page.evaluate(() => document.querySelector("#card")?.value ?? null);

let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const popup = await fox.openExtensionPage("popup.html");
  await poll(popup, () => document.body.dataset.ready === "1");

  // The user stores the test card and sets a $100 cap for the shop.
  await setValues(popup, { "#card-number": CARD.number, "#card-exp": CARD.exp, "#card-cvc": CARD.cvc, "#shop-host": "shop.localhost", "#shop-cap": "100" });
  check("setup: the popup stores the card and the cap", "ready", await press(popup, "#setup", "#setup-result"));
  check("E6: the card fields are empty after setup", ["", "", ""], await popup.evaluate(() => ["#card-number", "#card-exp", "#card-cvc"].map((s) => document.querySelector(s).value)));

  // E1: a $26.00 order (Trail Mug $18 + $8 shipping), under the cap.
  await addToCart({ sku: "trail-mug", qty: "1", color: "Slate" });
  const checkout = await openCheckout();
  await setValues(popup, { "#merchant": "shop.localhost", "#amount": "2600", "#reason": "Trail Mug for Ada", "#key": "order-e2e-0001" });
  check("E1: the agent's request waits for approval", "ask", await press(popup, "#ask", "#ask-result"));
  check("E1: the card is not filled before approval", "", await cardValue(checkout));
  const pending = await texts(popup, "#pending li .summary");
  check("E5: the popup lists one waiting approval", 1, pending.length);
  check("E5: the approval shows merchant, amount, currency, and reason", true, /shop\.localhost/.test(pending[0] ?? "") && /\$26\.00/.test(pending[0] ?? "") && /USD/.test(pending[0] ?? "") && /Trail Mug for Ada/.test(pending[0] ?? ""));
  check("E5: the exact action JSON holds the amount", true, (await texts(popup, "#pending li pre"))[0]?.includes('"amount":2600'));
  check("E1: one approval submits the order", "submitted", await press(popup, "#pending li .approve", "#approve-result"));
  const orders = () => shopServer.state.orders.map((o) => ({ total: o.total, cardLast4: o.cardLast4, skus: o.lines.map((l) => l.sku), name: o.name }));
  check("E1: the shop server sees one order with the right total and test card", [{ total: 26, cardLast4: "4242", skus: ["trail-mug"], name: "Ada Lovelace" }], orders());
  check("E1: the tab shows the order page", true, await poll(checkout, () => /\/shop\/order\/TH-/.test(location.pathname)));
  await checkout.close();

  // E2: a $500 gift card is over the cap. foxpay refuses before any fill.
  await addToCart({ sku: "gift-card", qty: "1" });
  const big = await openCheckout();
  await setValues(popup, { "#amount": "50000", "#reason": "Gift card", "#key": "order-e2e-0002" });
  check("E2: an over-cap order is refused", "refused: spend-cap", await press(popup, "#ask", "#ask-result"));
  check("E2: the card field stays empty", "", await cardValue(big));
  check("E2: the shop has no new order", 1, shopServer.state.orders.length);
  check("E2: no approval waits", 0, (await texts(popup, "#pending li")).length);

  // E5: the budget and the receipts.
  check("E5: the budget shows the cap and what is left", ["USD: cap $100.00, spent $26.00, left $74.00"], await texts(popup, "#budget li"));
  check("E5: the popup lists one receipt", ["submitted: $26.00 USD to shop.localhost, Trail Mug for Ada, card ending 4242"], await texts(popup, "#receipts li"));

  // E3: an x402 call pays one time, after one approval.
  await setValues(popup, { "#wallet-key": WALLET, "#api-host": "api.localhost", "#pay-to": PAY_TO, "#api-cap": "0.05" });
  check("setup: the popup stores the test wallet and the API cap", "ready", await press(popup, "#setup-api", "#setup-api-result"));
  check("E6: the wallet field is empty after setup", "", await popup.evaluate(() => document.querySelector("#wallet-key").value));
  await setValues(popup, { "#api-url": `${paid.url}/weather`, "#api-amount": "10000", "#api-reason": "Weather for the trip", "#api-key": "call-e2e-0001" });
  check("E3: the paid call waits for approval", "ask", await press(popup, "#call", "#call-result"));
  check("E3: nothing is signed before approval", 0, signed().length);
  const apiPending = await texts(popup, "#pending li .summary");
  check("E5: the approval shows the amount in test USDC and the API host", ["Pay 0.010000 USDC to api.localhost for: Weather for the trip"], apiPending);
  check("E5: the exact action JSON names the recipient and the network", true, (await texts(popup, "#pending li pre"))[0]?.includes(`"payee":"${PAY_TO} on eip155:84532"`));
  check("E3: one approval pays", "paid", await press(popup, "#pending li .approve", "#approve-result"));
  check("E3: the popup shows the paid answer", '{"forecast":"sunny"}', await popup.evaluate(() => document.querySelector("#approve-body").textContent));
  check("E3: the fake API settles one payment from the test wallet", [{ payer: addressOf(WALLET), value: "10000" }], paid.api.settled.map((x) => ({ payer: x.payer, value: x.value })));

  // E4: a replayed payment header does not pay again, and neither does a retry.
  const replay = await fetch(`${paid.url}/weather`, { headers: { "payment-signature": signed()[0].payment } });
  check("E4: the replayed header gets 402", 402, replay.status);
  check("E4: the fake facilitator names the used nonce", "nonce_used", JSON.parse(atob(replay.headers.get("payment-response"))).errorReason);
  check("E4: a retry with the same key gives the receipt", "paid", await press(popup, "#call", "#call-result"));
  check("E4: still one settlement and one signed request from the extension", [1, 2], [paid.api.settled.length, signed().length]);

  check("E5: the budget shows both caps", ["USD: cap $100.00, spent $26.00, left $74.00", "Base Sepolia USDC: cap 0.050000, spent 0.010000, left 0.040000"], await texts(popup, "#budget li"));
  check("E5: the receipts list both payments", 2, (await texts(popup, "#receipts li")).length);

  // E6: no card data and no wallet key in the popup or in storage.local.
  const stored = JSON.stringify(await popup.evaluate(() => browser.storage.local.get(null)));
  const html = await popup.evaluate(() => document.documentElement.outerHTML);
  const secrets = [CARD.number, `${CARD.exp} ${CARD.cvc}`, WALLET.slice(2), WALLET.slice(2).toUpperCase()];
  check("E6: storage.local and the popup hold no card data and no wallet key", false, secrets.some((v) => stored.includes(v) || html.includes(v)));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await shopServer.close();
  await paid.close();
}
record.passed = !record.error && record.checks.length >= 32 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
