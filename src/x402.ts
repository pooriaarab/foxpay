// x402 v2, scheme "exact", on Base Sepolia only: read the 402 answer, check
// it against what the host expects, and after approval sign one EIP-3009
// authorization with the wallet key in foxvault (docs/failure-modes.md X1-X12).
import { normalizeHost } from "foxgate";
import type { Vault } from "foxvault";
import { addressOf, signAuthorization, type Authorization } from "./eip712.js";
import { PayRefusal, type Intent, type PayContext, type PayMethod, type PayOutcome } from "./intent.js";

/** The only network that foxpay pays on: Base Sepolia, a testnet, with its test USDC. */
export const BASE_SEPOLIA = Object.freeze({ network: "eip155:84532", chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" });

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
}
export interface PaymentPayload {
  x402Version: 2;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: Authorization };
}

/** Base64 of the UTF-8 JSON, as the x402 HTTP headers carry it. */
export function encodeHeader(value: unknown): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), (b) => String.fromCharCode(b)).join(""));
}
/** The JSON in an x402 header. Throws for text that is not base64 JSON. */
export function decodeHeader(text: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0))));
}

export interface X402Options {
  /** The foxvault vault that holds the wallet key. */
  vault: Vault;
  /** The handle of the wallet key: 0x and 64 hex digits. Use a testnet wallet. */
  wallet: string;
  /** The recipient that each merchant host must name, for example `{ "api.example.com": "0x..." }`. */
  payTo: Record<string, string>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Check the settlement yourself, for example on a Base Sepolia RPC node. When it says no, the receipt is `unsettled`. */
  confirm?: (settlement: { transaction: string; network: string; payer: string }) => Promise<boolean>;
  /** The longest time a signed authorization stays valid. Default: 300 seconds. */
  maxTimeoutSeconds?: number;
  now?: () => number;
}

interface Hold {
  url: string;
  resource: PaymentPayload["resource"];
  accepted: PaymentRequirements;
}

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const loopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost");
const bytes32 = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

// Why one entry of `accepts` is not the payment the host expects, or undefined when it is (X1-X3, X6).
function mismatch(r: Record<string, unknown>, payTo: string): string | undefined {
  if (r.scheme !== "exact") return "scheme";
  if (r.network !== BASE_SEPOLIA.network) return "network";
  if (!same(r.asset, BASE_SEPOLIA.asset)) return "asset";
  if (!same(r.payTo, payTo)) return "recipient";
  const extra = plain(r.extra) ? r.extra : {};
  if (extra.name !== BASE_SEPOLIA.name || extra.version !== BASE_SEPOLIA.version) return "token domain";
  return undefined;
}

function target(intent: Intent): URL {
  let url: URL;
  try {
    url = new URL(String(intent.target?.url));
  } catch {
    throw new PayRefusal("bad-target", "x402 needs target.url.");
  }
  // Plain http only to this machine, for local tests.
  const ok = url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname));
  if (!ok || normalizeHost(url.hostname) !== intent.merchant) throw new PayRefusal("merchant-mismatch", `The URL is not an https URL on ${intent.merchant}.`);
  return url;
}

export function x402(options: X402Options): PayMethod {
  const { vault, wallet } = options;
  const http = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const maxTimeout = options.maxTimeoutSeconds ?? 300;

  async function quote(intent: Intent) {
    const url = target(intent);
    const payTo = Object.hasOwn(options.payTo, intent.merchant) ? options.payTo[intent.merchant]! : undefined;
    if (!payTo) throw new PayRefusal("no-recipient", `No recipient is set for ${intent.merchant}.`);
    if (!(await vault.list()).some((s) => s.handle === wallet)) throw new PayRefusal("no-wallet", "The vault does not hold the wallet key.");
    // No redirects: a signed payload must go to the approved URL only (X15).
    const res = await http(url.href, { redirect: "manual" }).catch(() => undefined);
    if (res?.status !== 402) throw new PayRefusal("not-402", "The URL did not answer 402 Payment Required.");
    let required: unknown;
    try {
      required = decodeHeader(res.headers.get("payment-required") ?? "");
    } catch {
      throw new PayRefusal("bad-requirements", "The PAYMENT-REQUIRED header is not base64 JSON.");
    }
    if (!plain(required) || required.x402Version !== 2 || !Array.isArray(required.accepts)) throw new PayRefusal("bad-requirements", "The 402 answer is not x402 version 2.");
    const resource = plain(required.resource) ? required.resource : {};
    let resourceHost = "";
    try {
      resourceHost = normalizeHost(new URL(String(resource.url)).hostname);
    } catch {
      throw new PayRefusal("bad-requirements", "The 402 answer has no resource URL.");
    }
    if (resourceHost !== intent.merchant) throw new PayRefusal("merchant-mismatch", `The 402 resource is on ${resourceHost}, not ${intent.merchant}.`);
    const accepts = required.accepts.filter(plain);
    const fits = accepts.find((r) => mismatch(r, payTo) === undefined);
    if (!fits) throw new PayRefusal("requirements-mismatch", `The 402 answer asks for another ${accepts.map((r) => mismatch(r, payTo)).join(", ") || "payment"} than foxpay expects.`);
    const amount = typeof fits.amount === "string" && /^[1-9]\d*$/.test(fits.amount) ? Number(fits.amount) : NaN;
    const timeout = Number(fits.maxTimeoutSeconds);
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(timeout) || timeout <= 0) throw new PayRefusal("bad-requirements", "The 402 amount or timeout is not a whole number that fits.");
    const accepted: PaymentRequirements = { scheme: "exact", network: BASE_SEPOLIA.network, amount: fits.amount as string, asset: fits.asset as string, payTo: fits.payTo as string, maxTimeoutSeconds: timeout, extra: { name: BASE_SEPOLIA.name, version: BASE_SEPOLIA.version } };
    const hold: Hold = { url: url.href, resource: { url: String(resource.url) }, accepted };
    return { amount, currency: "USDC", payee: `${accepted.payTo} on ${BASE_SEPOLIA.network}`, hold };
  }

  // Before foxgate uses the token: the vault is open, and the 402 still asks for the approved payment (X12, X16).
  async function check({ intent, quote: q }: PayContext) {
    if ((await vault.status()) !== "unlocked" && !(await vault.unlock().then(() => true, () => false))) return "locked";
    const { accepted } = q.hold as Hold;
    try {
      const now402 = await quote(intent);
      const fresh = (now402.hold as Hold).accepted;
      return fresh.amount === accepted.amount && same(fresh.payTo, accepted.payTo) && same(fresh.asset, accepted.asset) ? undefined : "amount-changed";
    } catch (error) {
      if (error instanceof PayRefusal) return error.reason === "requirements-mismatch" ? "amount-changed" : error.reason;
      throw error;
    }
  }

  async function pay({ quote: q }: PayContext): Promise<PayOutcome> {
    // Sign exactly the approved requirements, never fresh ones (I16, X10).
    const { url, resource, accepted } = q.hold as Hold;
    const t = Math.floor(now() / 1000);
    const nonce = bytes32();
    const domain = { name: BASE_SEPOLIA.name, version: BASE_SEPOLIA.version, chainId: BASE_SEPOLIA.chainId, verifyingContract: accepted.asset };
    let signed: { authorization: Authorization; signature: string };
    try {
      // The key exists only inside this function (X11).
      signed = await vault.use(wallet, (key) => {
        const authorization = { from: addressOf(key), to: accepted.payTo, value: accepted.amount, validAfter: String(t - 600), validBefore: String(t + Math.min(accepted.maxTimeoutSeconds, maxTimeout)), nonce };
        return { authorization, signature: signAuthorization(key, domain, authorization) };
      });
    } catch {
      return { status: "failed", reason: "sign-error" };
    }
    const proof = { network: BASE_SEPOLIA.network, payer: signed.authorization.from, nonce };
    const payload: PaymentPayload = { x402Version: 2, resource, accepted, payload: signed };
    // One send per payload. foxpay never sends it again (X8).
    const res = await http(url, { headers: { "payment-signature": encodeHeader(payload) }, redirect: "manual" }).catch(() => undefined);
    if (!res) return { status: "unsettled", reason: "no-response", proof };
    let settlement: Record<string, unknown> = {};
    try {
      const decoded = decodeHeader(res.headers.get("payment-response") ?? "");
      if (plain(decoded)) settlement = decoded;
    } catch {
      // No settlement header: handled below.
    }
    if (res.status < 200 || res.status > 299) {
      // Only an explicit refusal is a failure. Any other error can still settle before validBefore (X14).
      const refused = res.status === 402 && settlement.success === false && typeof settlement.errorReason === "string" && /^[a-z0-9_]{1,64}$/.test(settlement.errorReason);
      return refused ? { status: "failed", reason: settlement.errorReason as string, proof } : { status: "unsettled", reason: `http-${res.status}`, proof };
    }
    const body = await res.text();
    const transaction = settlement.transaction;
    const settled = settlement.success === true && typeof transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction) && settlement.network === BASE_SEPOLIA.network;
    if (!settled) return { status: "unsettled", reason: "no-settlement", proof, body };
    const full = { ...proof, transaction: transaction as string };
    if (options.confirm && !(await options.confirm(full).catch(() => false))) return { status: "unsettled", reason: "not-confirmed", proof: full, body };
    return { status: "paid", proof: full, body };
  }

  return { quote, check, pay };
}
