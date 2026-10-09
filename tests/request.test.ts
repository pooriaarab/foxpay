// Failure modes I1-I7, I12, I14, and I15 in docs/failure-modes.md: what
// happens before the human approves.
import { describe, expect, it } from "vitest";
import { ask, intent, setup, spent } from "./helpers.js";

describe("request", () => {
  it("I14: the approval names merchant, amount, currency, reason, method, and payee", async () => {
    const t = await setup();
    await ask(t);
    const [request] = await t.host.pending();
    for (const part of ['"merchant":"shop.example"', '"amount":1999', '"currency":"USD"', '"reason":"Trail mug, slate"', '"method":"fake"', '"payee":"shop.example"'])
      expect(request!.text).toContain(part);
    expect(t.events.map((e) => e.kind)).toEqual(["pay.request", "pay.ask"]);
    expect(t.fake.calls.pay).toBe(0);
  });

  it("a grant with approval never pays at once, one time", async () => {
    const t = await setup({ approval: "never" });
    const done = await t.pay.request(intent());
    expect(done).toMatchObject({ status: "paid", receipt: { merchant: "shop.example", amount: 1999, status: "paid", proof: { ref: "r-1" } } });
    expect(await t.pay.request(intent())).toEqual(done);
    expect(t.fake.calls.pay).toBe(1);
    expect(await spent(t)).toBe(1999);
    expect(await t.pay.receipts()).toHaveLength(1);
  });

  it("I1: a planner amount that differs from the quote is refused with no approval", async () => {
    const t = await setup();
    t.fake.state.price = 2500;
    expect(await t.pay.request(intent())).toMatchObject({ status: "refused", reason: "amount-mismatch" });
    expect(await t.host.pending()).toHaveLength(0);
  });

  it("I2: a planner currency that differs from the quote is refused", async () => {
    const t = await setup();
    t.fake.state.currency = "EUR";
    expect(await t.pay.request(intent())).toMatchObject({ status: "refused", reason: "currency-mismatch" });
  });

  it("I3: a currency that is not the cap currency is denied, never converted", async () => {
    const t = await setup();
    t.fake.state.currency = "EUR";
    expect(await t.pay.request(intent({ currency: "EUR" }))).toMatchObject({ status: "refused", reason: "currency" });
    expect(t.fake.calls.pay).toBe(0);
  });

  it("I4: an amount over the cap is denied before any approval or method call", async () => {
    const t = await setup();
    t.fake.state.price = 6000;
    expect(await t.pay.request(intent({ amount: 6000 }))).toMatchObject({ status: "refused", reason: "spend-cap" });
    expect(await t.host.pending()).toHaveLength(0);
    expect(t.fake.calls).toMatchObject({ check: 0, pay: 0 });
  });

  it("I5: an intent that is not valid is refused", async () => {
    const t = await setup();
    const bad = [
      { merchant: "https://shop.example/" }, { merchant: "" }, { amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: "1999" },
      { currency: "usd" }, { currency: "DOLLARS" }, { reason: "" }, { reason: "x".repeat(201) }, { method: "nope" }, { method: "toString" },
      { idempotencyKey: undefined }, { idempotencyKey: "short" }, { extra: true },
    ];
    for (const over of bad) expect(await t.pay.request(intent(over)), JSON.stringify(over)).toMatchObject({ status: "refused", reason: "bad-intent" });
    expect(await t.pay.request(null as never)).toMatchObject({ status: "refused", reason: "bad-intent" });
    expect(t.fake.calls.quote).toBe(0);
  });

  it("I6: a retry with the same key gives the same request", async () => {
    const t = await setup();
    const first = await ask(t);
    expect((await ask(t)).requestId).toBe(first.requestId);
    expect(await t.host.pending()).toHaveLength(1);
    expect(t.fake.calls.quote).toBe(1);
  });

  it("I7: a key that is used for a different intent is refused", async () => {
    const t = await setup();
    await ask(t);
    expect(await t.pay.request(intent({ reason: "Something else" }))).toMatchObject({ status: "refused", reason: "key-reused" });
  });

  it("I12: a rejected request never pays", async () => {
    const t = await setup();
    const asked = await ask(t);
    await t.host.reject(asked.requestId);
    expect(await t.pay.request(intent())).toMatchObject({ status: "refused", reason: "rejected" });
    expect(t.fake.calls.pay).toBe(0);
  });

  it("I15: a stored record that is not readable stops everything", async () => {
    const t = await setup();
    await t.store.set("foxpay", { v: 9, nonsense: true });
    expect(await t.pay.request(intent())).toMatchObject({ status: "refused", reason: "storage-error" });
    expect(t.fake.calls.quote).toBe(0);
  });

  it("I13: a hook that throws stops the request", async () => {
    const t = await setup({}, () => {
      throw new Error("no log");
    });
    expect(await t.pay.request(intent())).toMatchObject({ status: "refused", reason: "hook-failed" });
    expect(t.fake.calls.quote).toBe(0);
  });
});
