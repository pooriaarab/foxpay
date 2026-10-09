// Payment intents: check an intent, quote it on the host side, ask foxgate,
// and run the method one time after the human approves
// (docs/failure-modes.md I1-I17).
import { canonicalJson, normalizeHost, type Action, type Gate, type Store, type ToolSpec } from "foxgate";

/** The foxgate tool name of every payment. Register it with `payTools()`. */
export const PAY_TOOL = "foxpay.pay";

/**
 * foxgate takes 3-letter currency codes. Test USDC on Base Sepolia counts as
 * XTS, the ISO 4217 code for testing, in whole atomic units (6 decimals).
 */
export const GATE_CURRENCY: Readonly<Record<string, string>> = Object.freeze({ USDC: "XTS" });
const gateCurrency = (currency: string) => GATE_CURRENCY[currency] ?? currency;

/** The foxgate tool registry for foxpay. The amount comes from the quote, which foxpay puts in the args. */
export function payTools(): Record<string, ToolSpec> {
  return {
    [PAY_TOOL]: { scope: "pay", amount: (args) => ({ value: args.amount as number, currency: gateCurrency(args.currency as string) }) },
  };
}

/** One wish to pay, from the planner. */
export interface Intent {
  /** The merchant host, for example `shop.example.com`. */
  merchant: string;
  /** Whole minor units: cents for USD, atomic units for USDC. */
  amount: number;
  currency: string;
  /** Why the agent pays. The human sees it. 1 to 200 characters. */
  reason: string;
  /** The name of a method in `createFoxpay({ methods })`. */
  method: string;
  /** The same key for every retry of this payment. 8 to 128 characters. */
  idempotencyKey: string;
  /** What the method needs to find the payment: `{ tabId }` for card fill, `{ url }` for x402. */
  target?: Record<string, unknown>;
}

/** What the host reads itself, from the merchant page or the 402 answer. */
export interface Quote {
  amount: number;
  currency: string;
  /** Who gets the money, as the human sees it. */
  payee: string;
  /** More facts that the human must see, for example the URL that a payment is for. The token binds them. */
  details?: Record<string, string>;
  /** Plain JSON that the method keeps for check and pay. It goes into the store, so never a secret. */
  hold?: unknown;
}

export interface PayContext {
  id: string;
  intent: Intent;
  quote: Quote;
}

export type PayStatus = "paid" | "submitted" | "unsettled" | "failed";

export interface PayOutcome {
  status: PayStatus;
  reason?: string;
  /** Plain JSON, never a secret: last 4 digits, a transaction hash, a page URL. */
  proof?: Record<string, unknown>;
  /** The response body, for x402. It is not stored. */
  body?: string;
}

/**
 * A way to pay. Throw `PayRefusal` to refuse with a reason. From `pay`, throw
 * it only before any money can move: foxpay records it as `failed`. Any other
 * error from `pay` is recorded as `unsettled`.
 */
export interface PayMethod {
  quote(intent: Intent): Promise<Quote>;
  /** Runs before foxgate uses the token. Return a reason to stop, for example `amount-changed` or `locked`. */
  check?(context: PayContext): Promise<string | undefined>;
  pay(context: PayContext): Promise<PayOutcome>;
}

/** Throw it from a method to refuse with a reason that callers can switch on. From `pay`, only before any money can move. */
export class PayRefusal extends Error {
  constructor(readonly reason: string, message = reason) {
    super(message);
  }
}

export interface Receipt {
  id: string;
  merchant: string;
  amount: number;
  currency: string;
  reason: string;
  method: string;
  payee: string;
  status: PayStatus;
  failure?: string;
  requestId?: string;
  paidAt: number;
  proof: Record<string, unknown>;
}

/** A foxtrail-compatible entry: pass `log.append` as `onEvent`. */
export interface PayEvent {
  actor: "foxpay";
  kind: "pay.request" | "pay.ask" | "pay.refused" | "pay.start" | "pay.approved" | "pay.result";
  data: Record<string, unknown>;
}

export type RequestResult =
  | { status: "ask"; id: string; requestId: string }
  | { status: "refused"; id?: string; reason: string; message: string }
  | { status: PayStatus; id: string; receipt: Receipt; body?: string };
export type CompleteResult = Exclude<RequestResult, { status: "ask" }>;

interface Rec {
  id: string;
  intent: Intent;
  quote: Quote;
  action: Action;
  status: "awaiting" | "paying" | PayStatus;
  requestId?: string;
  receipt?: Receipt;
}
interface Data {
  v: 1;
  intents: Record<string, Rec>;
}

export interface FoxpayOptions {
  /** A foxgate gate made with `payTools()`. */
  gate: Gate;
  methods: Record<string, PayMethod>;
  /** Where intents and receipts live. Use the same store as foxgate. */
  store: Store;
  onEvent?: (event: PayEvent) => void | Promise<void>;
  now?: () => number;
}

const KEY = "foxpay";
const INTENT_KEYS = new Set(["merchant", "amount", "currency", "reason", "method", "idempotencyKey", "target"]);
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refused = (reason: string, message: string, id?: string): RequestResult => ({ status: "refused", ...(id && { id }), reason, message });

const bad = (why: string): never => {
  throw new PayRefusal("bad-intent", `The intent is not valid: ${why}.`);
};
const summary = (rec: Rec) => ({ id: rec.id, merchant: rec.intent.merchant, amount: rec.quote.amount, currency: rec.quote.currency, reason: rec.intent.reason, method: rec.intent.method, payee: rec.quote.payee });
// A method error that is not a PayRefusal can hold anything, so its message is dropped.
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw error instanceof PayRefusal ? error : new PayRefusal("method-error", "The payment method failed.");
  }
}

function parseIntent(input: unknown, methods: Record<string, PayMethod>): Intent {
  if (!plain(input)) return bad("not an object");
  for (const k of Object.keys(input)) if (!INTENT_KEYS.has(k)) bad(`unknown field ${k}`);
  const { merchant, amount, currency, reason, method, idempotencyKey, target } = input;
  let host = "";
  try {
    host = normalizeHost(merchant as string);
  } catch {
    bad("merchant must be a host name");
  }
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) bad("amount must be a whole number of minor units above 0");
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(gateCurrency(currency))) bad("currency must be a 3-letter code or USDC");
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 200) bad("reason must have 1 to 200 characters");
  if (typeof method !== "string" || !Object.hasOwn(methods, method)) bad("unknown method");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) bad("idempotencyKey must have 8 to 128 characters");
  if (target !== undefined && !plain(target)) bad("target must be an object");
  const intent = { merchant: host, amount, currency, reason, method, idempotencyKey, ...(target !== undefined && { target }) } as Intent;
  try {
    canonicalJson(intent);
  } catch {
    bad("not plain JSON");
  }
  return intent;
}

export function createFoxpay(options: FoxpayOptions) {
  const { gate, methods, store, onEvent } = options;
  const now = options.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };

  async function load(): Promise<Data> {
    const raw = await store.get(KEY);
    if (raw === undefined || raw === null) return { v: 1, intents: {} };
    if (!plain(raw) || raw.v !== 1 || !plain(raw.intents)) throw new PayRefusal("storage-error", "The stored foxpay record has a wrong shape.");
    return raw as unknown as Data;
  }
  const save = (data: Data) => store.set(KEY, data);
  // Intents that pay now, in this object. After a restart, "paying" means the outcome is not known.
  const running = new Set<string>();
  const done = (rec: Rec): CompleteResult => {
    if (rec.status !== "paying") return { status: rec.status as PayStatus, id: rec.id, receipt: rec.receipt! };
    if (running.has(rec.id)) return refused("in-progress", "This intent pays now.", rec.id) as CompleteResult;
    return refused("outcome-unknown", "A payment for this intent started, and its outcome is not known. foxpay does not pay it again.", rec.id) as CompleteResult;
  };
  async function emit(kind: PayEvent["kind"], data: Record<string, unknown>) {
    try {
      await onEvent?.({ actor: "foxpay", kind, data });
    } catch {
      throw new PayRefusal("hook-failed", "The onEvent hook failed.");
    }
  }
  // Ask foxgate about the stored action. A pending request comes back with the same id.
  // The answer "pay" means that foxgate allowed it with no approval and counted the spend.
  async function decide(data: Data, rec: Rec): Promise<RequestResult | "pay"> {
    const decision = await gate.check(rec.action);
    if (decision.decision === "deny") {
      delete data.intents[rec.id];
      await save(data);
      await emit("pay.refused", { ...summary(rec), why: decision.reason }).catch(() => undefined);
      return refused(decision.reason, decision.message, rec.id);
    }
    if (decision.decision === "ask") {
      rec.requestId = decision.requestId;
      data.intents[rec.id] = rec;
      await save(data);
      await emit("pay.ask", { ...summary(rec), requestId: decision.requestId });
      return { status: "ask", id: rec.id, requestId: decision.requestId };
    }
    rec.status = "paying";
    data.intents[rec.id] = rec;
    await save(data);
    running.add(rec.id);
    await emit("pay.approved", { ...summary(rec), grantId: decision.grantId }).catch(() => undefined);
    return "pay";
  }

  async function run(rec: Rec): Promise<CompleteResult> {
    const method = methods[rec.intent.method]!;
    let outcome: PayOutcome;
    try {
      outcome = await method.pay({ id: rec.id, intent: rec.intent, quote: rec.quote });
    } catch (error) {
      // A PayRefusal is a promise that no money moved. Any other error can come
      // after money moved, so the outcome is not known (I19).
      outcome = error instanceof PayRefusal ? { status: "failed", reason: error.reason } : { status: "unsettled", reason: "method-error" };
    }
    const receipt: Receipt = {
      ...summary(rec),
      status: outcome.status,
      ...(outcome.reason && { failure: outcome.reason }),
      ...(rec.requestId && { requestId: rec.requestId }),
      paidAt: now(),
      proof: outcome.proof ?? {},
    };
    return locked(async () => {
      running.delete(rec.id);
      // When the save fails, the store keeps "paying", so a later call refuses outcome-unknown.
      try {
        const data = await load();
        data.intents[rec.id] = { ...(data.intents[rec.id] ?? rec), status: outcome.status, receipt };
        await save(data);
      } catch {
        // The result below is still true: the method ran.
      }
      // The money moved. A failed hook cannot undo that, so it does not change the result.
      await emit("pay.result", { ...receipt }).catch(() => undefined);
      return { status: outcome.status, id: rec.id, receipt, ...(outcome.body !== undefined && { body: outcome.body }) } as CompleteResult;
    });
  }

  async function request(input: unknown): Promise<RequestResult> {
    try {
      const out = await locked(async (): Promise<RequestResult | Rec> => {
        const intent = parseIntent(input, methods);
        const data = await load();
        const id = `fpy-${intent.idempotencyKey}`;
        const old = data.intents[id];
        if (old) {
          if (canonicalJson(old.intent) !== canonicalJson(intent)) return refused("key-reused", "This idempotency key belongs to a different intent.", id);
          if (old.status !== "awaiting") return done(old);
          // The grant can now allow it with no approval, so the method check runs first (I18).
          const check = methods[old.intent.method]!.check;
          const stop = check && (await guard(() => check({ id, intent: old.intent, quote: old.quote })));
          if (stop) return refused(stop, `The payment cannot run now: ${stop}.`, id);
          const again = await decide(data, old);
          return again === "pay" ? old : again;
        }
        await emit("pay.request", { merchant: intent.merchant, amount: intent.amount, currency: intent.currency, reason: intent.reason, method: intent.method });
        const quote = await guard(() => methods[intent.method]!.quote(intent));
        if (quote.currency !== intent.currency) return refused("currency-mismatch", `The merchant asks for ${quote.currency}, not ${intent.currency}. foxpay does not convert.`);
        if (quote.amount !== intent.amount) return refused("amount-mismatch", `The merchant asks for ${quote.amount}, not ${intent.amount}.`);
        const args = { intent: id, merchant: intent.merchant, amount: quote.amount, currency: quote.currency, reason: intent.reason, method: intent.method, payee: quote.payee, ...(quote.details && { details: quote.details }) };
        const rec: Rec = { id, intent, quote, action: { tool: PAY_TOOL, scope: "pay", domain: intent.merchant, args }, status: "awaiting" };
        const result = await decide(data, rec);
        return result === "pay" ? rec : result;
      });
      return "action" in out ? run(out) : out;
    } catch (error) {
      if (error instanceof PayRefusal) return refused(error.reason, error.message);
      return refused("storage-error", "Cannot read or save the foxpay record.");
    }
  }

  async function complete(id: string, token: string): Promise<CompleteResult> {
    let rec: Rec | undefined;
    try {
      const out = await locked(async (): Promise<CompleteResult | undefined> => {
        const data = await load();
        const found = typeof id === "string" && Object.hasOwn(data.intents, id) ? data.intents[id] : undefined;
        if (!found) return refused("not-found", "No intent has this id.") as CompleteResult;
        if (found.status !== "awaiting") return done(found);
        // The method checks the page or the vault before foxgate uses the token (I16, I17).
        const check = methods[found.intent.method]!.check;
        const stop = check && (await guard(() => check({ id, intent: found.intent, quote: found.quote })));
        if (stop) return refused(stop, `The payment cannot run now: ${stop}.`, id) as CompleteResult;
        await emit("pay.start", summary(found));
        const decision = await gate.redeem(token, found.action);
        if (decision.decision !== "allow") {
          const deny = decision.decision === "deny" ? decision : { reason: "bad-token", message: "The token is not valid." };
          return refused(deny.reason, deny.message, id) as CompleteResult;
        }
        found.status = "paying";
        await save(data);
        running.add(id);
        await emit("pay.approved", { ...summary(found), requestId: found.requestId }).catch(() => undefined);
        rec = found;
        return undefined;
      });
      if (out) return out;
    } catch (error) {
      if (error instanceof PayRefusal) return refused(error.reason, error.message, id) as CompleteResult;
      return refused("storage-error", "Cannot read or save the foxpay record.", id) as CompleteResult;
    }
    // A second call at the same time sees "paying" above, so this runs one time (I8).
    return run(rec!);
  }

  async function list(): Promise<Rec[]> {
    return Object.values((await load()).intents);
  }

  return Object.freeze({
    /** Check an intent, quote it, and ask foxgate. A retry with the same key gives the same answer. */
    request,
    /** Pay an approved intent with the foxgate token. It pays one time; later calls give the receipt. */
    complete,
    /** Every intent that waits, runs, or ran, with its quote and status. */
    intents: async () => (await list()).map((r) => ({ ...summary(r), status: r.status, ...(r.requestId && { requestId: r.requestId }) })),
    receipts: async () => (await list()).flatMap((r) => (r.receipt ? [r.receipt] : [])).toSorted((a, b) => a.paidAt - b.paidAt),
  });
}

export type Foxpay = ReturnType<typeof createFoxpay>;
