// Failure modes I6 and I8-I17 in docs/failure-modes.md: what happens after
// the human approves.
import { Log, MemoryStore, generateKey } from "foxtrail";
import { describe, expect, it } from "vitest";
import { createFoxpay } from "../src/index.js";
import { ask, intent, setup, spent, type Setup } from "./helpers.js";

const approve = async (t: Setup, asked: { id: string; requestId: string }) => t.pay.complete(asked.id, await t.host.approve(asked.requestId));

describe("complete", () => {
  it("one approval pays, and the receipt names the payment", async () => {
    const t = await setup();
    const asked = await ask(t);
    const done = await approve(t, asked);
    expect(done).toMatchObject({ status: "paid", receipt: { id: asked.id, merchant: "shop.example", amount: 1999, currency: "USD", reason: "Trail mug, slate", method: "fake", payee: "shop.example", status: "paid", requestId: asked.requestId, proof: { ref: "r-1" } } });
    expect(await t.pay.receipts()).toHaveLength(1);
    expect(await spent(t)).toBe(1999);
    expect(t.events.map((e) => e.kind)).toEqual(["pay.request", "pay.ask", "pay.start", "pay.approved", "pay.result"]);
  });

  it("the events go into a foxtrail log that verifies", async () => {
    const log = new Log({ store: new MemoryStore(), key: await generateKey() });
    const t = await setup();
    const pay = createFoxpay({ gate: t.gate, store: t.store, methods: { fake: t.fake.method }, onEvent: (e) => log.append(e).then(() => undefined) });
    const asked = await pay.request(intent());
    if (asked.status !== "ask") throw new Error("no ask");
    await pay.complete(asked.id, await t.host.approve(asked.requestId));
    expect(await log.verify()).toMatchObject({ ok: true, count: 5 });
  });

  it("I6: after payment, a retry gives the same receipt and pays no more", async () => {
    const t = await setup();
    const asked = await ask(t);
    const token = await t.host.approve(asked.requestId);
    const done = await t.pay.complete(asked.id, token);
    expect(await t.pay.request(intent())).toEqual(done);
    expect(await t.pay.complete(asked.id, token)).toEqual(done);
    expect(t.fake.calls.pay).toBe(1);
    expect(await spent(t)).toBe(1999);
  });

  it("I8: two completes at the same time pay one time", async () => {
    const t = await setup();
    const asked = await ask(t);
    const token = await t.host.approve(asked.requestId);
    const [a, b] = await Promise.all([t.pay.complete(asked.id, token), t.pay.complete(asked.id, token)]);
    expect([a.status, b.status].toSorted()).toEqual(["paid", "refused"]);
    expect([a, b].find((r) => r.status === "refused")).toMatchObject({ reason: "in-progress" });
    expect(t.fake.calls.pay).toBe(1);
  });

  it("I9: after a stop during payment, the outcome is unknown and nothing pays again", async () => {
    const t = await setup();
    const asked = await ask(t);
    t.fake.state.hang = true;
    void t.pay.complete(asked.id, await t.host.approve(asked.requestId));
    await new Promise((r) => setTimeout(r, 20));
    t.fake.state.hang = false;
    // A new foxpay object on the same store, as after a restart.
    const restarted = createFoxpay({ gate: t.gate, store: t.store, methods: { fake: t.fake.method } });
    expect(await restarted.complete(asked.id, "any-token")).toMatchObject({ status: "refused", reason: "outcome-unknown" });
    expect(await restarted.request(intent())).toMatchObject({ status: "refused", reason: "outcome-unknown" });
    expect(t.fake.calls.pay).toBe(1);
  });

  it("I10: two approved intents that pass the cap together: one pays, one gets spend-cap", async () => {
    const t = await setup();
    t.fake.state.price = 3000;
    const a = await ask(t, { amount: 3000, idempotencyKey: "order-000a" });
    const b = await ask(t, { amount: 3000, idempotencyKey: "order-000b" });
    const [ta, tb] = [await t.host.approve(a.requestId), await t.host.approve(b.requestId)];
    const results = await Promise.all([t.pay.complete(a.id, ta), t.pay.complete(b.id, tb)]);
    expect(results.map((r) => r.status).toSorted()).toEqual(["paid", "refused"]);
    expect(results.find((r) => r.status === "refused")).toMatchObject({ reason: "spend-cap" });
    expect(await spent(t)).toBe(3000);
    expect(t.fake.calls.pay).toBe(1);
  });

  it("I11: the token of one intent does not complete another", async () => {
    const t = await setup();
    const a = await ask(t, { idempotencyKey: "order-000a" });
    const b = await ask(t, { idempotencyKey: "order-000b", reason: "Ridge tee" });
    expect(await t.pay.complete(b.id, await t.host.approve(a.requestId))).toMatchObject({ status: "refused", reason: "action-changed" });
    expect((await approve(t, b)).status).toBe("paid");
    expect(t.fake.calls.pay).toBe(1);
  });

  it("I13: a hook that throws before payment stops it, and no spend is counted", async () => {
    const t = await setup({}, (e) => {
      if (e.kind === "pay.start") throw new Error("log is full");
    });
    expect(await approve(t, await ask(t))).toMatchObject({ status: "refused", reason: "hook-failed" });
    expect(t.fake.calls.pay).toBe(0);
    expect(await spent(t)).toBe(0);
  });

  it("I16: an amount change after approval is caught before the token is used", async () => {
    const t = await setup();
    const asked = await ask(t);
    t.fake.state.checkReason = "amount-changed";
    expect(await approve(t, asked)).toMatchObject({ status: "refused", reason: "amount-changed" });
    expect(t.fake.calls.pay).toBe(0);
    expect(await spent(t)).toBe(0);
  });

  it("I17: a locked vault refuses before the token is used, so the same token works after unlock", async () => {
    const t = await setup();
    const asked = await ask(t);
    const token = await t.host.approve(asked.requestId);
    t.fake.state.checkReason = "locked";
    expect(await t.pay.complete(asked.id, token)).toMatchObject({ status: "refused", reason: "locked" });
    t.fake.state.checkReason = undefined;
    expect((await t.pay.complete(asked.id, token)).status).toBe("paid");
  });

  it("a method that throws fails the payment with no message from the method", async () => {
    const t = await setup();
    t.fake.state.fail = true;
    const done = await approve(t, await ask(t));
    expect(done).toMatchObject({ status: "failed", receipt: { status: "failed", failure: "method-error" } });
    expect(JSON.stringify([done, t.events, await t.store.get("foxpay")])).not.toContain("4242");
  });

  it("an unknown intent id is refused", async () => {
    const t = await setup();
    expect(await t.pay.complete("fpy-nothing-here", "token")).toMatchObject({ status: "refused", reason: "not-found" });
  });
});
