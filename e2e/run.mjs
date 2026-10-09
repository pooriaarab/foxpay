// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, pay through its popup, and write artifacts/e2e-<date>.json. It
// checks failure modes E1, E2, E5, and E6 in docs/failure-modes.md.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
//
// The shop is the foxbench Trailhead Supply site on shop.localhost. Firefox
// sends *.localhost to the loopback address. The card is a test card; no
// money moves.
import { launch, poll, writeArtifact } from "create-foxkit/e2e";
import { sites, startServer } from "foxbench";

const CARD = { number: "4242424242424242", exp: "12/30", cvc: "737" };
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

  // E6: the card number is not in the popup or in storage.local.
  const stored = JSON.stringify(await popup.evaluate(() => browser.storage.local.get(null)));
  const html = await popup.evaluate(() => document.documentElement.outerHTML);
  check("E6: storage.local and the popup hold no card data", false, [CARD.number, `${CARD.exp} ${CARD.cvc}`].some((v) => stored.includes(v) || html.includes(v)));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await shopServer.close();
}
record.passed = !record.error && record.checks.length >= 17 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
