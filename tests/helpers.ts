// Shared setup for the intent tests: a real foxgate, a fake payment method,
// and an intent builder. No money moves.
import { createFoxgate, memoryStore, type GrantInput } from "foxgate";
import { PAY_TOOL, createFoxpay, payTools, type PayMethod } from "../src/index.js";

export function fakeMethod() {
  const calls = { quote: 0, check: 0, pay: 0 };
  const state = { price: 1999, currency: "USD", checkReason: undefined as string | undefined, hang: false, fail: false };
  const method: PayMethod = {
    async quote(intent) {
      calls.quote++;
      return { amount: state.price, currency: state.currency, payee: intent.merchant, hold: { page: 1 } };
    },
    async check() {
      calls.check++;
      return state.checkReason;
    },
    async pay() {
      calls.pay++;
      if (state.hang) await new Promise(() => undefined);
      if (state.fail) throw new Error("card 4242424242424242 declined");
      return { status: "paid", proof: { ref: `r-${calls.pay}` } };
    },
  };
  return { method, calls, state };
}

export async function setup(grant: Partial<GrantInput> = {}, onEvent?: (e: { kind: string }) => void) {
  const store = memoryStore();
  const { gate, host } = createFoxgate({ tools: payTools(), store });
  await host.addGrant({ scope: "pay", domains: ["shop.example"], tools: [PAY_TOOL], spendCap: { value: 5000, currency: "USD" }, ...grant });
  const fake = fakeMethod();
  const events: { actor: string; kind: string; data: unknown }[] = [];
  const record = (e: { actor: string; kind: string; data: unknown }) => {
    onEvent?.(e);
    events.push(e);
  };
  const pay = createFoxpay({ gate, store, methods: { fake: fake.method }, onEvent: record });
  return { gate, host, store, pay, fake, events };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export const intent = (over: Record<string, unknown> = {}) => ({
  merchant: "shop.example",
  amount: 1999,
  currency: "USD",
  reason: "Trail mug, slate",
  method: "fake",
  idempotencyKey: "order-0001",
  ...over,
});

export async function ask(t: Setup, over: Record<string, unknown> = {}) {
  const r = await t.pay.request(intent(over));
  if (r.status !== "ask") throw new Error(`expected ask, got ${JSON.stringify(r)}`);
  return r;
}
export const spent = async (t: Setup) => (await t.host.grants())[0]!.spent;
