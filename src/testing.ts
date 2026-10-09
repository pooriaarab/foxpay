// Test doubles for foxpay: a fake x402 API with a local fake facilitator.
// No chain, no money. Use them in tests and demos only.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { recoverAuthorizer } from "./eip712.js";
import { BASE_SEPOLIA, decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequirements } from "./x402.js";

export interface FakeX402Options {
  /** The host of the API, for example `api.localhost`. */
  host: string;
  /** The recipient address. */
  payTo: string;
  /** The price in atomic USDC units (6 decimals). */
  price: number;
  /** The body of a paid answer. */
  body?: string;
  /** http for local E2E servers. Default: https. */
  protocol?: "http:" | "https:";
  now?: () => number;
}

/**
 * A fake paid API. `handle` takes a Request and returns a Response, so a
 * test can pass `api.fetch` to x402() and an E2E server can wrap `handle`.
 * Change `price`, `override`, or `settle` between calls to test failures.
 */
export function fakeX402Api(options: FakeX402Options) {
  const now = options.now ?? Date.now;
  const used = new Set<string>();
  const api = {
    price: options.price,
    /** Fields that replace the honest requirements, for example `{ network: "eip155:8453" }`. */
    override: {} as Partial<PaymentRequirements> & { resourceUrl?: string },
    /** "ok" settles. The others answer success with no real settlement. */
    settle: "ok" as "ok" | "no-transaction" | "wrong-network" | "insufficient-funds",
    /** When set, the API settles the payment and then answers with this status, as a failing proxy would. */
    statusAfterSettle: null as number | null,
    /** When false, the URL answers 200 with no payment. */
    paid: true,
    /** Every request: the path and the payment header, if any. */
    log: [] as { path: string; payment: string | null; status: number }[],
    /** One entry for each settled payment. */
    settled: [] as { payer: string; value: string; nonce: string; transaction: string }[],
    requirements(): PaymentRequirements {
      const { resourceUrl: _, ...rest } = api.override;
      return { scheme: "exact", network: BASE_SEPOLIA.network, amount: String(api.price), asset: BASE_SEPOLIA.asset, payTo: options.payTo, maxTimeoutSeconds: 60, extra: { name: BASE_SEPOLIA.name, version: BASE_SEPOLIA.version }, ...rest };
    },
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const payment = request.headers.get("payment-signature");
      const reply = (status: number, body: string, headers: Record<string, string> = {}) => {
        api.log.push({ path: url.pathname, payment, status });
        return new Response(body, { status, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "payment-required, payment-response", ...headers } });
      };
      if (!api.paid) return reply(200, options.body ?? "ok");
      const resource = { url: api.override.resourceUrl ?? `${options.protocol ?? "https:"}//${options.host}${url.pathname}`, description: "Fake paid API", mimeType: "text/plain" };
      const required = (error: string) => reply(402, "{}", { "payment-required": encodeHeader({ x402Version: 2, error, resource, accepts: [api.requirements()] }) });
      if (!payment) return required("PAYMENT-SIGNATURE header is required");
      const refuse = (errorReason: string) => reply(402, "{}", { "payment-response": encodeHeader({ success: false, errorReason, transaction: "", network: BASE_SEPOLIA.network }) });
      let payload: PaymentPayload;
      try {
        payload = decodeHeader(payment) as PaymentPayload;
      } catch {
        return reply(400, "Invalid Payment");
      }
      // The fake facilitator: verify, then settle one time per nonce.
      const want = api.requirements();
      const a = payload?.payload?.authorization;
      const got = payload?.accepted;
      if (payload?.x402Version !== 2 || !a || !got) return reply(400, "Invalid Payment");
      if (got.network !== want.network || got.asset !== want.asset || got.payTo !== want.payTo || got.amount !== want.amount || a.value !== want.amount || a.to !== want.payTo) return refuse("invalid_exact_evm_payload_mismatch");
      const t = Math.floor(now() / 1000);
      if (Number(a.validBefore) <= t || Number(a.validAfter) > t) return refuse("invalid_exact_evm_payload_authorization_valid_before");
      if (used.has(a.nonce.toLowerCase())) return refuse("nonce_used");
      if (api.settle === "insufficient-funds") return refuse("insufficient_funds");
      let payer: string;
      try {
        payer = recoverAuthorizer({ name: BASE_SEPOLIA.name, version: BASE_SEPOLIA.version, chainId: BASE_SEPOLIA.chainId, verifyingContract: want.asset }, a, payload.payload.signature);
      } catch {
        return refuse("invalid_exact_evm_payload_signature");
      }
      if (payer !== a.from) return refuse("invalid_exact_evm_payload_signature");
      used.add(a.nonce.toLowerCase());
      const transaction = `0x${Array.from(keccak_256(new TextEncoder().encode(a.nonce)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      api.settled.push({ payer, value: a.value, nonce: a.nonce, transaction });
      const settlement = { success: true, payer, network: api.settle === "wrong-network" ? "eip155:8453" : BASE_SEPOLIA.network, transaction: api.settle === "no-transaction" ? "" : transaction };
      if (api.statusAfterSettle !== null) return reply(api.statusAfterSettle, "error");
      return reply(200, options.body ?? "ok", { "payment-response": encodeHeader(settlement) });
    },
    fetch: (input: string | URL | Request, init?: RequestInit) => api.handle(new Request(input, init)),
  };
  return api;
}
