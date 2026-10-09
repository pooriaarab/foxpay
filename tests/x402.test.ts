// Failure modes X1-X12 in docs/failure-modes.md: x402 on Base Sepolia, with
// the fake API and its local fake facilitator. No chain, no money.
import { createFoxgate, memoryStore } from "foxgate";
import { createVault } from "foxvault";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, PAY_TOOL, addressOf, createFoxpay, decodeHeader, encodeHeader, payTools, x402 } from "../src/index.js";
import { fakeX402Api } from "../src/testing.js";

const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const URL1 = "https://api.example/weather";

async function setup(opts: { passphrase?: string; confirm?: () => Promise<boolean> } = {}) {
  const store = memoryStore();
  const { gate, host } = createFoxgate({ tools: payTools(), store });
  await host.addGrant({ scope: "pay", domains: ["api.example"], tools: [PAY_TOOL], spendCap: { value: 50_000, currency: "XTS" } });
  const vault = createVault();
  await vault.initialize(opts.passphrase ? { passphrase: opts.passphrase } : {});
  if (opts.passphrase) await vault.unlock(opts.passphrase);
  await vault.set("vault:wallet", KEY, { domains: ["api.example"] });
  const api = fakeX402Api({ host: "api.example", payTo: PAY_TO, price: 10_000, body: "sunny" });
  const method = x402({ vault, wallet: "vault:wallet", payTo: { "api.example": PAY_TO }, fetch: api.fetch, ...(opts.confirm && { confirm: opts.confirm }) });
  const events: unknown[] = [];
  const pay = createFoxpay({ gate, store, methods: { x402: method }, onEvent: (e) => void events.push(e) });
  return { store, gate, host, vault, api, pay, events };
}
type S = Awaited<ReturnType<typeof setup>>;
const intent = (over: Record<string, unknown> = {}) => ({ merchant: "api.example", amount: 10_000, currency: "USDC", reason: "Weather data, one call", method: "x402", idempotencyKey: "call-0001", target: { url: URL1 }, ...over });
async function ask(s: S, over: Record<string, unknown> = {}) {
  const r = await s.pay.request(intent(over));
  if (r.status !== "ask") throw new Error(`expected ask, got ${JSON.stringify(r)}`);
  return r;
}
const approve = async (s: S, asked: { id: string; requestId: string }) => s.pay.complete(asked.id, await s.host.approve(asked.requestId));
const garbage = async () => new Response("{}", { status: 402, headers: { "payment-required": "not base64 json!" } });
const signed = (s: S) => s.api.log.filter((l) => l.payment !== null);

describe("x402", () => {
  it("one approval pays one time, and the receipt holds the settlement", async () => {
    const s = await setup();
    const asked = await ask(s);
    const [request] = await s.host.pending();
    expect(request!.text).toContain(`"payee":"${PAY_TO} on ${BASE_SEPOLIA.network}"`);
    expect(request!.action.amount).toEqual({ value: 10_000, currency: "XTS" });
    expect(signed(s)).toHaveLength(0);
    const done = await approve(s, asked);
    expect(done).toMatchObject({ status: "paid", body: "sunny", receipt: { status: "paid", amount: 10_000, currency: "USDC", proof: { network: BASE_SEPOLIA.network, payer: addressOf(KEY), transaction: s.api.settled[0]!.transaction } } });
    expect(s.api.settled).toHaveLength(1);
    expect((await s.host.grants())[0]!.spent).toBe(10_000);
  });

  it("X8: a replayed payload is refused, and a retry pays no more", async () => {
    const s = await setup();
    const asked = await ask(s);
    const token = await s.host.approve(asked.requestId);
    const done = await s.pay.complete(asked.id, token);
    const replay = await s.api.fetch(URL1, { headers: { "payment-signature": signed(s)[0]!.payment! } });
    expect(replay.status).toBe(402);
    expect(decodeHeader(replay.headers.get("payment-response")!)).toMatchObject({ success: false, errorReason: "nonce_used" });
    // The body is not stored, so a retry gives the receipt without it.
    const { body: _, ...stored } = done as typeof done & { body?: string };
    expect(await s.pay.complete(asked.id, token)).toEqual(stored);
    expect(await s.pay.request(intent())).toEqual(stored);
    expect(s.api.settled).toHaveLength(1);
    const second = await approve(s, await ask(s, { idempotencyKey: "call-0002" }));
    expect(second.status).toBe("paid");
    expect(s.api.settled.map((x) => x.nonce)).toHaveLength(new Set(s.api.settled.map((x) => x.nonce)).size);
  });

  it("X1-X3, X6: requirements for another network, asset, recipient, or token domain are refused with no signature", async () => {
    const cases = [{ network: "eip155:8453" }, { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, { payTo: "0x857b06519E91e3A54538791bDbb0E22373e36b66" }, { extra: { name: "USD Coin", version: "2" } }, { extra: { name: "USDC", version: "1" } }, { scheme: "upto" }];
    for (const override of cases) {
      const s = await setup();
      s.api.override = override;
      expect(await s.pay.request(intent()), JSON.stringify(override)).toMatchObject({ status: "refused", reason: "requirements-mismatch" });
      expect(signed(s)).toHaveLength(0);
    }
  });

  it("X4: a URL or a resource on another host is refused", async () => {
    const s = await setup();
    expect(await s.pay.request(intent({ target: { url: "https://evil.example/weather" } }))).toMatchObject({ status: "refused", reason: "merchant-mismatch" });
    s.api.override = { resourceUrl: "https://evil.example/weather" };
    expect(await s.pay.request(intent())).toMatchObject({ status: "refused", reason: "merchant-mismatch" });
    expect(await s.pay.request(intent({ target: { url: "ftp://api.example/weather" } }))).toMatchObject({ status: "refused", reason: "merchant-mismatch" });
  });

  it("X5: a header that is not valid, or an amount that does not fit, is refused", async () => {
    for (const amount of ["1e5", "-1", "10000.5", "99999999999999999999", ""]) {
      const s = await setup();
      s.api.override = { amount };
      expect(await s.pay.request(intent()), amount).toMatchObject({ status: "refused", reason: "bad-requirements" });
    }
    const s = await setup();
    const pay = createFoxpay({ gate: s.gate, store: s.store, methods: { x402: x402({ vault: s.vault, wallet: "vault:wallet", payTo: { "api.example": PAY_TO }, fetch: garbage }) } });
    expect(await pay.request(intent())).toMatchObject({ status: "refused", reason: "bad-requirements" });
  });

  it("X7: a URL that answers with no 402 is refused", async () => {
    const s = await setup();
    s.api.paid = false;
    expect(await s.pay.request(intent())).toMatchObject({ status: "refused", reason: "not-402" });
  });

  it("I1, I2: a planner amount or currency that differs from the 402 is refused", async () => {
    const s = await setup();
    expect(await s.pay.request(intent({ amount: 5000 }))).toMatchObject({ status: "refused", reason: "amount-mismatch" });
    expect(await s.pay.request(intent({ currency: "USD", idempotencyKey: "call-usd-1" }))).toMatchObject({ status: "refused", reason: "currency-mismatch" });
  });

  it("X9: success with no settlement is unsettled, not paid", async () => {
    for (const mode of ["no-transaction", "wrong-network"] as const) {
      const s = await setup();
      s.api.settle = mode;
      expect(await approve(s, await ask(s)), mode).toMatchObject({ status: "unsettled", receipt: { status: "unsettled", failure: "no-settlement" } });
    }
    const s = await setup({ confirm: async () => false });
    expect(await approve(s, await ask(s))).toMatchObject({ status: "unsettled", receipt: { failure: "not-confirmed" } });
  });

  it("X10: a refusal by the facilitator fails, and foxpay signs one time only", async () => {
    const s = await setup();
    const asked = await ask(s);
    s.api.settle = "insufficient-funds";
    expect(await approve(s, asked)).toMatchObject({ status: "failed", receipt: { failure: "insufficient_funds" } });
    expect(signed(s)).toHaveLength(1);
    expect(s.api.settled).toHaveLength(0);
  });

  it("X14: an error answer after the signed payment is unsettled, not failed", async () => {
    for (const status of [500, 502, 402]) {
      const s = await setup();
      const asked = await ask(s);
      s.api.statusAfterSettle = status;
      expect(await approve(s, asked), String(status)).toMatchObject({ status: "unsettled", receipt: { failure: `http-${status}` } });
      expect(s.api.settled).toHaveLength(1);
    }
  });

  it("X15: foxpay does not follow redirects", async () => {
    const s = await setup();
    const seen: (string | undefined)[] = [];
    const redirecting = (status: number) => async (input: string, init?: RequestInit) => {
      seen.push(init?.redirect);
      if (init?.headers) return new Response("", { status, headers: { location: "https://evil.example/" } });
      return s.api.fetch(input, init);
    };
    const pay = createFoxpay({ gate: s.gate, store: s.store, methods: { x402: x402({ vault: s.vault, wallet: "vault:wallet", payTo: { "api.example": PAY_TO }, fetch: redirecting(302) }) } });
    const asked = await pay.request(intent());
    if (asked.status !== "ask") throw new Error("no ask");
    expect(await pay.complete(asked.id, await s.host.approve(asked.requestId))).toMatchObject({ status: "unsettled", receipt: { failure: "http-302" } });
    expect(seen.every((r) => r === "manual")).toBe(true);
    const moved = async () => new Response("", { status: 301, headers: { location: "https://evil.example/" } });
    const pay2 = createFoxpay({ gate: s.gate, store: s.store, methods: { x402: x402({ vault: s.vault, wallet: "vault:wallet", payTo: { "api.example": PAY_TO }, fetch: moved }) } });
    expect(await pay2.request(intent({ idempotencyKey: "call-0301" }))).toMatchObject({ status: "refused", reason: "not-402" });
  });

  it("X16: a price change after approval is refused before the token is used", async () => {
    const s = await setup();
    const asked = await ask(s);
    s.api.price = 20_000;
    expect(await approve(s, asked)).toMatchObject({ status: "refused", reason: "amount-changed" });
    expect(signed(s)).toHaveLength(0);
    expect((await s.host.grants())[0]!.spent).toBe(0);
  });

  it("X11: the wallet key is in no result, event, receipt, store, or error", async () => {
    const s = await setup();
    const done = await approve(s, await ask(s));
    const bad = await s.pay.request(intent({ idempotencyKey: "call-0009", target: { url: "https://evil.example/" } }));
    const all = JSON.stringify([done, bad, s.events, await s.pay.receipts(), await s.pay.intents(), await s.store.get("foxpay"), await s.store.get("foxgate"), s.api.log]);
    for (const form of [KEY, KEY.slice(2), KEY.slice(2).toUpperCase()]) expect(all).not.toContain(form);
  });

  it("X12: a locked vault is refused before the token is used", async () => {
    const s = await setup({ passphrase: "correct horse battery" });
    const asked = await ask(s);
    s.vault.lock();
    expect(await approve(s, asked)).toMatchObject({ status: "refused", reason: "locked" });
    expect(signed(s)).toHaveLength(0);
    expect((await s.host.grants())[0]!.spent).toBe(0);
  });

  it("the header codec round-trips JSON", () => {
    expect(decodeHeader(encodeHeader({ a: "é", n: 1 }))).toEqual({ a: "é", n: 1 });
    expect(() => decodeHeader("%%%")).toThrow();
  });
});
