// Failure modes C1-C10 in docs/failure-modes.md: card fill. Each tab is a
// jsdom page, so the bundled page functions run against a real DOM. Test
// card numbers only; no money moves.
import { createFoxgate, memoryStore } from "foxgate";
import { FILL_TOOL, createVault } from "foxvault";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { PAY_TOOL, cardFill, createFoxpay, payTools, type CardBrowser, type VirtualCardProvider } from "../src/index.js";

const NUMBER = "4242424242424242";
const DETAILS = "12/30 737";
const checkout = (total = "$26.00", form = `<input name="card" id="card">`) => `<main><div class="card"><p><strong>Total ${total}</strong></p></div>
<form id="f">${form}<input name="exp" id="exp"><input name="cvc" id="cvc"><button id="pay" type="submit">Pay</button></form></main>`;
const PAGE_GLOBALS = ["document", "location", "HTMLInputElement", "HTMLTextAreaElement", "HTMLElement", "Event"] as const;

// Tabs with one top document each. A submit records the form and loads a new document.
function fakeTabs() {
  const tabs = new Map<number, { url: string; documentId: string; dom: JSDOM }>();
  const submitted: Record<string, string>[] = [];
  const targets: unknown[] = [];
  const hooks: { before?: (fn: string, dom: JSDOM) => void; frame?: (call: number) => void } = {};
  let frames = 0;
  let docs = 0;
  const open = (tabId: number, url: string, html: string) => {
    const dom = new JSDOM(html, { url });
    dom.window.document.querySelector("form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted.push(Object.fromEntries(new dom.window.FormData(e.target as HTMLFormElement)) as Record<string, string>);
      open(tabId, `${url}/done`, "<p>Thank you</p>");
    });
    tabs.set(tabId, { url, documentId: `doc-${++docs}`, dom });
    return dom;
  };
  const browser: CardBrowser = {
    webNavigation: {
      getFrame: async ({ tabId, frameId }) => {
        hooks.frame?.(++frames);
        const tab = tabs.get(tabId);
        return frameId === 0 && tab ? { url: tab.url, documentId: tab.documentId } : null;
      },
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        targets.push(target);
        const tab = tabs.get(target.tabId);
        if (!tab || target.documentIds.length !== 1 || target.documentIds[0] !== tab.documentId) throw new Error("No document with that ID");
        hooks.before?.(func.name, tab.dom);
        const g = globalThis as Record<string, unknown>;
        const saved = PAGE_GLOBALS.map((k) => Object.getOwnPropertyDescriptor(g, k));
        for (const k of PAGE_GLOBALS) Object.defineProperty(g, k, { value: (tab.dom.window as unknown as Record<string, unknown>)[k], configurable: true, writable: true });
        try {
          return [{ result: (func as (...a: unknown[]) => unknown)(...args) }];
        } finally {
          PAGE_GLOBALS.forEach((k, i) => (saved[i] ? Object.defineProperty(g, k, saved[i]!) : delete g[k]));
        }
      },
    },
  };
  return { tabs, open, browser, submitted, targets, hooks };
}

async function setup(opts: { url?: string; html?: string; cardDomains?: string[]; provider?: VirtualCardProvider; passphrase?: string; beforePay?: (t: ReturnType<typeof fakeTabs>) => void } = {}) {
  const store = memoryStore();
  const { gate, host } = createFoxgate({ tools: { ...payTools(), [FILL_TOOL]: "fill" }, store });
  await host.addGrant({ scope: "pay", domains: ["shop.example"], tools: [PAY_TOOL], spendCap: { value: 5000, currency: "USD" } });
  await host.addGrant({ scope: "fill", domains: ["shop.example"], tools: [FILL_TOOL] });
  const t = fakeTabs();
  t.open(1, opts.url ?? "https://shop.example/checkout", opts.html ?? checkout());
  const vault = createVault({ gate, browser: t.browser, iterations: 600_000 });
  await vault.initialize(opts.passphrase ? { passphrase: opts.passphrase } : {});
  if (opts.passphrase) await vault.unlock(opts.passphrase);
  await vault.set("vault:card", NUMBER, { domains: opts.cardDomains ?? ["shop.example"] });
  await vault.set("vault:card.details", DETAILS, { domains: opts.cardDomains ?? ["shop.example"] });
  const card = cardFill({
    vault,
    browser: t.browser,
    ...(opts.provider ? { provider: opts.provider } : { card: { number: "vault:card", details: "vault:card.details" } }),
    fields: { number: "#card", exp: "#exp", cvc: "#cvc" },
    total: ".card strong",
    submit: "#pay",
    currency: "USD",
    waitMs: 300,
  });
  const events: unknown[] = [];
  // beforePay runs after the check and before the payment, as a page load in between would.
  const method = opts.beforePay ? { ...card, pay: (ctx: Parameters<typeof card.pay>[0]) => (opts.beforePay!(t), card.pay(ctx)) } : card;
  const pay = createFoxpay({ gate, store, methods: { card: method }, onEvent: (e) => void events.push(e) });
  return { ...t, gate, host, vault, pay, events };
}
type S = Awaited<ReturnType<typeof setup>>;
const intent = (over: Record<string, unknown> = {}) => ({ merchant: "shop.example", amount: 2600, currency: "USD", reason: "Trail mug order", method: "card", idempotencyKey: "order-card-1", target: { tabId: 1 }, ...over });
async function ask(s: S, over: Record<string, unknown> = {}) {
  const r = await s.pay.request(intent(over));
  if (r.status !== "ask") throw new Error(`expected ask, got ${JSON.stringify(r)}`);
  return r;
}
const approve = async (s: S, asked: { id: string; requestId: string }) => s.pay.complete(asked.id, await s.host.approve(asked.requestId));
const spent = async (s: S) => (await s.host.grants()).find((g) => g.scope === "pay")!.spent;
const field = (s: S, selector: string) => (s.tabs.get(1)!.dom.window.document.querySelector(selector) as HTMLInputElement | null)?.value ?? null;

describe("card fill", () => {
  it("one approval fills the stored card and submits; C9: no card data leaves", async () => {
    const s = await setup();
    const done = await approve(s, await ask(s));
    expect(done).toMatchObject({ status: "submitted", receipt: { amount: 2600, payee: "shop.example", proof: { last4: "4242", card: "vault:card", page: "https://shop.example/checkout/done" } } });
    expect(s.submitted).toEqual([{ card: NUMBER, exp: "12/30", cvc: "737" }]);
    expect(s.targets.every((t) => JSON.stringify(t) === JSON.stringify({ tabId: 1, documentIds: ["doc-1"] }))).toBe(true);
    const out = JSON.stringify([done, s.events, await s.pay.receipts(), await s.pay.intents()]);
    for (const secret of [NUMBER, "12/30", "737"]) expect(out).not.toContain(secret);
  });

  it("C1: a tab on another merchant is refused before any fill", async () => {
    const s = await setup({ url: "https://other.example/checkout" });
    expect(await s.pay.request(intent())).toMatchObject({ status: "refused", reason: "merchant-mismatch" });
    expect(field(s, "#card")).toBe("");
  });

  it("C2: look-alike hosts are refused; a Unicode merchant shows as punycode", async () => {
    for (const url of ["https://shop.examp1e/checkout", "https://shop.example.evil.test/checkout", "https://xn--shp-ckd.example/checkout", "https://shоp.example/checkout"]) {
      const s = await setup({ url });
      expect(await s.pay.request(intent()), url).toMatchObject({ status: "refused", reason: "merchant-mismatch" });
    }
    const puny = new URL("https://shоp.example/").hostname;
    expect(puny.startsWith("xn--")).toBe(true);
    const s = await setup({ url: "https://shоp.example/checkout", cardDomains: [puny] });
    expect(await s.pay.request(intent({ merchant: "shоp.example" }))).toMatchObject({ status: "refused", reason: "no-grant", message: expect.stringContaining(puny) });
    expect(field(s, "#card")).toBe("");
  });

  it("C3: a new page after approval is refused before the token is used", async () => {
    const s = await setup();
    const asked = await ask(s);
    s.open(1, "https://shop.example/checkout", checkout());
    expect(await approve(s, asked)).toMatchObject({ status: "refused", reason: "page-changed" });
    expect([field(s, "#card"), s.submitted.length, await spent(s)]).toEqual(["", 0, 0]);
  });

  it("C11: a new page after the check gets no card number", async () => {
    const s = await setup({ beforePay: (t) => void t.open(1, "https://shop.example/checkout", checkout()) });
    expect(await approve(s, await ask(s))).toMatchObject({ status: "failed", receipt: { failure: "page-changed" } });
    expect([field(s, "#card"), s.submitted.length]).toEqual(["", 0]);
  });

  it("C16: a page load just before the foxvault fill gets no card number", async () => {
    const s = await setup();
    const asked = await ask(s);
    const token = await s.host.approve(asked.requestId);
    let start = 0;
    // Calls after complete starts: the check, the last check in pay, then foxvault fill.
    s.hooks.frame = (n) => {
      if (start === 0) start = n;
      if (n === start + 2) s.open(1, "https://shop.example/checkout", checkout());
    };
    expect(await s.pay.complete(asked.id, token)).toMatchObject({ status: "failed", receipt: { failure: "page-changed" } });
    expect([field(s, "#card"), s.submitted.length]).toEqual(["", 0]);
  });

  it("C12: a virtual card that cannot be stored leaves no handle behind", async () => {
    const s = await setup({ provider: { createCard: async () => ({ id: "vc_3", number: "4000056655665556", exp: "1/2", cvc: "" }) } });
    expect(await approve(s, await ask(s))).toMatchObject({ status: "failed" });
    expect((await s.vault.list()).map((x) => x.handle).toSorted()).toEqual(["vault:card", "vault:card.details"]);
    expect(field(s, "#card")).toBe("");
  });

  it("C13: a lost submit result is unsettled, not failed", async () => {
    const s = await setup();
    const asked = await ask(s);
    s.hooks.before = (fn) => {
      if (fn === "submitCheckout") throw new Error("the page navigated");
    };
    expect(await approve(s, asked)).toMatchObject({ status: "unsettled", receipt: { failure: "submit-unknown" } });
  });

  it("C14: a failure after the number fill clears the card fields", async () => {
    const s = await setup({ html: checkout("$26.00", `<input name="card" id="card"></form><form>`).replace('<input name="exp" id="exp">', "") });
    expect(await approve(s, await ask(s))).toMatchObject({ status: "failed", receipt: { failure: "not-found" } });
    expect(field(s, "#card")).toBe("");
  });

  it("C15: a failed payment cancels the virtual card; a submitted one does not", async () => {
    const cancelled: string[] = [];
    const provider: VirtualCardProvider = {
      createCard: async () => ({ id: `vc_${cancelled.length}`, number: "4000056655665556", exp: "11/29", cvc: "424" }),
      cancelCard: async (id) => void cancelled.push(id),
    };
    const ok = await setup({ provider });
    expect((await approve(ok, await ask(ok))).status).toBe("submitted");
    expect(cancelled).toEqual([]);
    const bad = await setup({ provider, html: checkout("$26.00", "") });
    expect((await approve(bad, await ask(bad))).status).toBe("failed");
    expect(cancelled).toEqual(["vc_0"]);
  });

  it("C4: a total that changes after approval is refused before the fill", async () => {
    const s = await setup();
    const asked = await ask(s);
    s.tabs.get(1)!.dom.window.document.querySelector(".card strong")!.textContent = "Total $99.00";
    expect(await approve(s, asked)).toMatchObject({ status: "refused", reason: "amount-changed" });
    expect([field(s, "#card"), s.submitted.length, await spent(s)]).toEqual(["", 0, 0]);
  });

  it("C4: a total that changes just before submit stops the submit", async () => {
    const s = await setup();
    const asked = await ask(s);
    s.hooks.before = (fn, dom) => {
      if (fn === "submitCheckout") dom.window.document.querySelector(".card strong")!.textContent = "Total $99.00";
    };
    expect(await approve(s, asked)).toMatchObject({ status: "failed", receipt: { failure: "amount-changed" } });
    expect(s.submitted).toHaveLength(0);
  });

  it("C5: a card field that is only in an iframe is not filled", async () => {
    const s = await setup({ html: checkout("$26.00", `<iframe srcdoc="<input id='card'>"></iframe>`) });
    expect(await approve(s, await ask(s))).toMatchObject({ status: "failed", receipt: { failure: "not-found" } });
    expect([field(s, "#exp"), s.submitted.length]).toEqual(["", 0]);
  });

  it("C6: a plain http merchant page is refused", async () => {
    const s = await setup({ url: "http://shop.example/checkout" });
    expect(await s.pay.request(intent())).toMatchObject({ status: "refused", reason: "http" });
  });

  it("C7: a stored card that does not allow the merchant is refused at quote time", async () => {
    const s = await setup({ cardDomains: ["other.example"] });
    expect(await s.pay.request(intent())).toMatchObject({ status: "refused", reason: "domain" });
    expect(await s.host.pending()).toHaveLength(0);
  });

  it("C8: a page with no single total is refused", async () => {
    for (const total of ["", "soon", "$26.00 or $30.00", "$26.005"]) {
      const s = await setup({ html: checkout(total) });
      expect(await s.pay.request(intent()), total).toMatchObject({ status: "refused", reason: "no-total" });
    }
  });

  it("C10: a virtual card gets the approved limit and merchant, and leaves the vault after use", async () => {
    const asks: unknown[] = [];
    const provider: VirtualCardProvider = {
      createCard: async (req) => {
        asks.push(req);
        return { id: "vc_test_1", number: "4000056655665556", exp: "11/29", cvc: "424" };
      },
    };
    const s = await setup({ provider });
    const asked = await ask(s);
    const done = await approve(s, asked);
    expect(asks).toEqual([{ intentId: asked.id, merchant: "shop.example", amount: { value: 2600, currency: "USD" } }]);
    expect(done).toMatchObject({ status: "submitted", receipt: { proof: { last4: "5556", card: "vc_test_1" } } });
    expect(s.submitted).toEqual([{ card: "4000056655665556", exp: "11/29", cvc: "424" }]);
    expect((await s.vault.list()).map((x) => x.handle).toSorted()).toEqual(["vault:card", "vault:card.details"]);
    expect(JSON.stringify([done, s.events])).not.toContain("4000056655665556");
  });

  it("C10: a provider error fails with no fill, and a failed fill still removes the card", async () => {
    const broken = await setup({ provider: { createCard: async () => Promise.reject(new Error("issuing down")) } });
    expect(await approve(broken, await ask(broken))).toMatchObject({ status: "failed", receipt: { failure: "provider-error" } });
    expect(field(broken, "#card")).toBe("");
    const provider: VirtualCardProvider = { createCard: async () => ({ id: "vc_2", number: "4000056655665556", exp: "11/29", cvc: "424" }) };
    const s = await setup({ provider, html: checkout("$26.00", "") });
    expect(await approve(s, await ask(s))).toMatchObject({ status: "failed", receipt: { failure: "not-found" } });
    expect((await s.vault.list()).length).toBe(2);
  });

  it("I17: a locked passphrase vault is refused before the token is used", async () => {
    const s = await setup({ passphrase: "correct horse battery" });
    const asked = await ask(s);
    s.vault.lock();
    expect(await approve(s, asked)).toMatchObject({ status: "refused", reason: "locked" });
    expect([field(s, "#card"), await spent(s)]).toEqual(["", 0]);
  });
});
