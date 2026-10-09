// The demo background (an MV3 event page). It runs foxgate, foxvault, and
// foxpay with storage.local. The popup gets summaries and receipts, never a
// card number or a wallet key. A simulated agent asks to pay; the human
// approves in the popup. x402 pays on Base Sepolia only, here a local fake API.
import { createFoxgate, storageAreaStore } from "foxgate";
import { FILL_TOOL, createVault, indexedDbKeyStore } from "foxvault";
import { GATE_CURRENCY, PAY_TOOL, cardFill, createFoxpay, payTools, x402 } from "../src/index.ts";

const store = storageAreaStore(browser.storage.local);
const { gate, host } = createFoxgate({ tools: { ...payTools(), [FILL_TOOL]: "fill" }, store, publicSuffix: browser.publicSuffix });
const vault = createVault({ gate, browser, store, keyStore: indexedDbKeyStore(), publicSuffix: browser.publicSuffix });
// The Trailhead Supply checkout from foxbench. allowHttp is for the local demo only.
const card = cardFill({
  vault,
  browser,
  card: { number: "vault:card", details: "vault:card.details" },
  fields: { number: "#card", exp: "#exp", cvc: "#cvc" },
  total: "main > .card strong",
  submit: "form.card button[type=submit]",
  currency: "USD",
  allowHttp: true,
});
// The recipient for each API host, from setup. It lives in storage.local, because the event page unloads.
const payTo = {};
const api = x402({ vault, wallet: "vault:wallet", payTo });
const pay = createFoxpay({ gate, store, methods: { card, x402: api } });
const loadPayTo = async () => Object.assign(payTo, (await browser.storage.local.get("demoPayTo")).demoPayTo);

// The newest tab on the merchant host: the checkout the agent works in.
async function tabOf(merchant) {
  const tabs = (await browser.tabs.query({})).filter((t) => {
    try {
      return new URL(t.url).hostname === merchant;
    } catch {
      return false;
    }
  });
  return tabs.toSorted((a, b) => b.lastAccessed - a.lastAccessed)[0]?.id ?? -1;
}

const handlers = {
  async setup({ number, exp, cvc, shopHost, cap }) {
    if ((await vault.status()) === "new") await vault.initialize();
    for (const handle of ["vault:card", "vault:card.details"]) await vault.remove(handle);
    await vault.set("vault:card", number.replace(/\s/g, ""), { domains: [shopHost], allowHttp: true });
    await vault.set("vault:card.details", `${exp} ${cvc}`, { domains: [shopHost], allowHttp: true });
    for (const grant of await host.grants()) if (grant.spendCap?.currency !== GATE_CURRENCY.USDC) await host.revokeGrant(grant.id);
    await host.addGrant({ scope: "pay", domains: [shopHost], tools: [PAY_TOOL], spendCap: { value: Math.round(Number(cap) * 100), currency: "USD" } });
    await host.addGrant({ scope: "fill", domains: [shopHost], tools: [FILL_TOOL] });
    return "ready";
  },
  // A testnet wallet key, the recipient of the paid API, and a cap in test USDC (6 decimals).
  async setupApi({ walletKey, apiHost, recipient, cap }) {
    if ((await vault.status()) === "new") await vault.initialize();
    await vault.remove("vault:wallet");
    await vault.set("vault:wallet", walletKey.trim(), { domains: [apiHost], allowHttp: true });
    await browser.storage.local.set({ demoPayTo: { [apiHost]: recipient.trim() } });
    for (const grant of await host.grants()) if (grant.spendCap?.currency === GATE_CURRENCY.USDC) await host.revokeGrant(grant.id);
    await host.addGrant({ scope: "pay", domains: [apiHost], tools: [PAY_TOOL], spendCap: { value: Math.round(Number(cap) * 1e6), currency: GATE_CURRENCY.USDC } });
    return "ready";
  },
  async call({ url, amount, reason, key }) {
    await loadPayTo();
    return pay.request({ merchant: new URL(url).hostname, amount: Number(amount), currency: "USDC", reason, method: "x402", idempotencyKey: key, target: { url } });
  },
  // The simulated agent: it names the merchant, the amount, and the reason.
  async request({ merchant, amount, reason, key }) {
    return pay.request({ merchant, amount: Number(amount), currency: "USD", reason, method: "card", idempotencyKey: key, target: { tabId: await tabOf(merchant) } });
  },
  async approve({ id, requestId }) {
    await loadPayTo();
    return pay.complete(id, await host.approve(requestId));
  },
  async reject({ requestId }) {
    await host.reject(requestId);
    return { status: "rejected" };
  },
  async state() {
    const waiting = await host.pending();
    const intents = await pay.intents();
    const pending = waiting.filter((r) => r.status === "pending").map((r) => ({ requestId: r.id, text: r.text, intent: intents.find((i) => i.requestId === r.id) })).filter((p) => p.intent);
    const budget = (await host.grants()).filter((g) => g.scope === "pay").map((g) => ({ currency: g.spendCap.currency, cap: g.spendCap.value, spent: g.spent }));
    return { pending, budget, receipts: await pay.receipts() };
  },
};

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== browser.runtime.id || !Object.hasOwn(handlers, message?.type)) return undefined;
  try {
    return await handlers[message.type](message);
  } catch (error) {
    return { status: "error", reason: error.code ?? "error", message: error.message };
  }
});
