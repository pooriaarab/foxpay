// Card fill: read the checkout total from the merchant page, then fill a
// card from foxvault into the top document and submit, after approval
// (docs/failure-modes.md C1-C10).
import { matchesPattern, normalizeHost, parsePattern } from "foxgate";
import type { Vault } from "foxvault";
import { PayRefusal, type Intent, type PayContext, type PayMethod, type PayOutcome } from "./intent.js";

/** The parts of the WebExtension `browser` object that card fill uses. Pass the same object to foxvault. */
export interface CardBrowser {
  webNavigation: {
    getFrame(details: { tabId: number; frameId: number }): Promise<{ url: string; documentId?: string } | null | undefined>;
  };
  scripting: {
    executeScript(injection: { target: { tabId: number; documentIds: string[] }; func: (...args: never[]) => unknown; args: unknown[] }): Promise<{ result?: unknown }[]>;
  };
}

/** A card issuer that makes a single-use card for one merchant and one limit, such as Stripe Issuing. */
export interface VirtualCardProvider {
  createCard(request: { intentId: string; merchant: string; amount: { value: number; currency: string } }): Promise<{ id: string; number: string; exp: string; cvc: string }>;
}

export interface CardFillOptions {
  /** A foxvault vault with a gate that has a fill grant for the merchants, and the same `browser`. */
  vault: Vault;
  browser: CardBrowser;
  /** A stored card: the handle of the number, and the handle of `"MM/YY CVC"`. */
  card?: { number: string; details: string };
  /** Or a provider that makes a new card for each payment. */
  provider?: VirtualCardProvider;
  /** CSS selectors in the merchant checkout page. */
  fields: { number: string; exp: string; cvc: string };
  /** The element that holds the total, for example `Total $26.00`. */
  total: string;
  submit: string;
  /** The currency of the merchant. foxpay never reads it from the page. */
  currency: string;
  /** Digits after the decimal point. Default: 2. */
  decimals?: number;
  /** Allow plain http pages. For local tests only. */
  allowHttp?: boolean;
  /** How long to wait for the page after submit. Default: 10 seconds. */
  waitMs?: number;
}

// The page functions below run in the merchant page through
// scripting.executeScript. Firefox sends them as source text, so each one
// must not use anything from outside its own body.

export function readTotal(selector: string, host: string): string | null {
  if (location.hostname !== host) return null;
  return document.querySelector(selector)?.textContent ?? null;
}

export function fillDetails(expSelector: string, cvcSelector: string, exp: string, cvc: string, host: string): string {
  if (location.hostname !== host) return "host-changed";
  const exp1 = document.querySelector(expSelector);
  const cvc1 = document.querySelector(cvcSelector);
  if (!(exp1 instanceof HTMLInputElement) || !(cvc1 instanceof HTMLInputElement)) return "not-found";
  for (const [field, value] of [[exp1, exp], [cvc1, cvc]] as const) {
    field.focus();
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return "filled";
}

export function submitCheckout(submitSelector: string, totalSelector: string, totalText: string, host: string): string {
  if (location.hostname !== host) return "host-changed";
  if ((document.querySelector(totalSelector)?.textContent ?? null) !== totalText) return "amount-changed";
  const button = document.querySelector(submitSelector);
  if (!(button instanceof HTMLElement)) return "not-found";
  button.click();
  return "submitted";
}

/** Whole minor units from a total such as `Total $26.00`, or undefined when the text has not exactly one amount. */
export function parseTotal(text: string | null, decimals = 2): number | undefined {
  const found = (text ?? "").match(/\d[\d,]*(?:\.\d+)?/g);
  if (!found || found.length !== 1) return undefined;
  const [whole = "", frac = ""] = found[0]!.replace(/,/g, "").split(".");
  if (frac.length > decimals) return undefined;
  const value = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

interface Hold {
  tabId: number;
  documentId: string;
  totalText: string;
}

const allows = (domains: string[], host: string) =>
  domains.some((d) => {
    try {
      return matchesPattern(host, parsePattern(d));
    } catch {
      return false;
    }
  });

export function cardFill(options: CardFillOptions): PayMethod {
  const { vault, browser, card, provider, fields, currency } = options;
  if (!card === !provider) throw new TypeError("cardFill needs exactly one of card and provider.");
  const decimals = options.decimals ?? 2;
  const waitMs = options.waitMs ?? 10_000;

  // The top document of the tab, when it is the merchant page.
  async function topPage(tabId: number, merchant: string) {
    const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => undefined);
    if (!frame) throw new PayRefusal("no-tab", "The tab is not there.");
    let url: URL;
    try {
      url = new URL(frame.url);
    } catch {
      throw new PayRefusal("merchant-mismatch", "The tab does not show a web page.");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowHttp)) throw new PayRefusal(url.protocol === "http:" ? "http" : "merchant-mismatch", "The checkout page must use https.");
    // URL gives the punycode host, so a Unicode look-alike is a different host (C2).
    if (normalizeHost(url.hostname) !== merchant) throw new PayRefusal("merchant-mismatch", `The tab shows ${url.hostname}, not ${merchant}.`);
    if (!frame.documentId) throw new PayRefusal("page-changed", "The tab has no document id.");
    return { url: url.href, host: url.hostname, documentId: frame.documentId };
  }
  const run = async (tabId: number, documentId: string, func: (...args: never[]) => unknown, args: unknown[]) => {
    try {
      return (await browser.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, func, args }))[0]?.result;
    } catch {
      throw new PayRefusal("page-changed", "The checkout page changed.");
    }
  };
  const total = async (tabId: number, page: { host: string; documentId: string }) => {
    const text = await run(tabId, page.documentId, readTotal, [options.total, page.host]);
    const value = parseTotal(typeof text === "string" ? text : null, decimals);
    if (value === undefined) throw new PayRefusal("no-total", "The page has no total that foxpay can read.");
    return { text: text as string, value };
  };

  // The same page and the same total as at quote time (C3, C4).
  async function samePage(intent: Intent, hold: Hold) {
    const page = await topPage(hold.tabId, intent.merchant);
    if (page.documentId !== hold.documentId) throw new PayRefusal("page-changed", "The tab shows a new page since the approval.");
    if ((await total(hold.tabId, page)).text !== hold.totalText) throw new PayRefusal("amount-changed", "The checkout total changed since the approval.");
    return page;
  }

  async function quote(intent: Intent) {
    const tabId = intent.target?.tabId;
    if (!Number.isSafeInteger(tabId) || (tabId as number) < 0) throw new PayRefusal("bad-target", "Card fill needs target.tabId.");
    const page = await topPage(tabId as number, intent.merchant);
    if (card) {
      const stored = (await vault.list()).filter((s) => s.handle === card.number || s.handle === card.details);
      if (stored.length !== 2) throw new PayRefusal("no-card", "The vault does not hold the card.");
      if (!stored.every((s) => allows(s.domains, page.host))) throw new PayRefusal("domain", `The stored card does not allow ${page.host}.`);
    }
    const { text, value } = await total(tabId as number, page);
    const hold: Hold = { tabId: tabId as number, documentId: page.documentId, totalText: text };
    return { amount: value, currency, payee: page.host, hold };
  }

  async function check({ intent, quote: q }: PayContext) {
    try {
      await samePage(intent, q.hold as Hold);
    } catch (error) {
      if (error instanceof PayRefusal) return error.reason;
      throw error;
    }
    if ((await vault.status()) === "unlocked") return undefined;
    // Device mode unlocks with no passphrase. Passphrase mode stays locked (I17).
    return vault.unlock().then(() => undefined, () => "locked");
  }

  async function fill(intent: Intent, hold: Hold, handles: { number: string; details: string }): Promise<string> {
    // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- this is foxvault fill, not Array#fill
    const filled = await vault.fill({ handle: handles.number, tabId: hold.tabId, selector: fields.number });
    if (filled.status !== "filled") return filled.status === "refused" ? filled.reason : "fill-asks";
    const page = await samePage(intent, hold);
    const details = await vault.use(handles.details, async (value, info) => {
      if (!allows(info.domains, page.host)) return "domain";
      const [exp = "", cvc = ""] = value.split(" ");
      return run(hold.tabId, hold.documentId, fillDetails, [fields.exp, fields.cvc, exp, cvc, page.host]);
    });
    if (details !== "filled") return String(details);
    return String(await run(hold.tabId, hold.documentId, submitCheckout, [options.submit, options.total, hold.totalText, page.host]));
  }

  // The page after submit: wait until the tab has a new document.
  async function after(hold: Hold): Promise<string | undefined> {
    for (let waited = 0; waited <= waitMs; waited += 100) {
      const frame = await browser.webNavigation.getFrame({ tabId: hold.tabId, frameId: 0 }).catch(() => undefined);
      if (frame && frame.documentId !== hold.documentId) return frame.url;
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  }

  async function pay({ id, intent, quote: q }: PayContext): Promise<PayOutcome> {
    const hold = q.hold as Hold;
    let handles = card;
    let proof: Record<string, unknown> = {};
    if (provider) {
      let made: Awaited<ReturnType<VirtualCardProvider["createCard"]>>;
      try {
        made = await provider.createCard({ intentId: id, merchant: intent.merchant, amount: { value: q.amount, currency: q.currency } });
      } catch {
        return { status: "failed", reason: "provider-error" };
      }
      const name = `vault:fpy-vc-${crypto.randomUUID().slice(0, 8)}`;
      handles = { number: name, details: `${name}.details` };
      await vault.set(handles.number, made.number, { domains: [q.payee], allowHttp: options.allowHttp ?? false });
      await vault.set(handles.details, `${made.exp} ${made.cvc}`, { domains: [q.payee], allowHttp: options.allowHttp ?? false });
      proof = { last4: made.number.slice(-4), card: made.id };
    } else {
      proof = { last4: await vault.use(card!.number, (value) => value.slice(-4)), card: card!.number };
    }
    try {
      const result = await fill(intent, hold, handles!);
      if (result !== "submitted") return { status: "failed", reason: result, proof };
      const page = await after(hold);
      return { status: "submitted", proof: { ...proof, ...(page && { page }) } };
    } catch (error) {
      return { status: "failed", reason: error instanceof PayRefusal ? error.reason : "fill-error", proof };
    } finally {
      // A virtual card is for this payment only (C10).
      if (provider) for (const handle of [handles!.number, handles!.details]) await vault.remove(handle).catch(() => false);
    }
  }

  return { quote, check, pay };
}
