// Failure mode X13 in docs/failure-modes.md: the EIP-712 digest and the
// EIP-3009 signature must be the ones a real facilitator checks. viem is the
// independent reference; it is a dev dependency only.
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { addressOf, authorizationDigest, recoverAuthorizer, signAuthorization, type Authorization, type TokenDomain } from "../src/eip712.js";

const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const domain: TokenDomain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
const auth: Authorization = {
  from: privateKeyToAccount(KEY).address,
  to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  value: "10000",
  validAfter: "1740672089",
  validBefore: "1740672154",
  nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
};
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;
const message = { ...auth, from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, nonce: auth.nonce as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) };
const viemDomain = { ...domain, verifyingContract: domain.verifyingContract as `0x${string}` };
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

describe("EIP-712 TransferWithAuthorization", () => {
  it("X13: the address of a key is the one viem gives, with the EIP-55 checksum", () => {
    expect(addressOf(KEY)).toBe(privateKeyToAccount(KEY).address);
    expect(addressOf(`0x${"0".repeat(63)}1`)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });

  it("X13: the digest is the one viem gives", () => {
    expect(hex(authorizationDigest(domain, auth))).toBe(hashTypedData({ domain: viemDomain, types, primaryType: "TransferWithAuthorization", message }));
  });

  it("X13: the signature is the one viem gives, and it recovers to the signer", async () => {
    const ours = signAuthorization(KEY, domain, auth);
    const theirs = await privateKeyToAccount(KEY).signTypedData({ domain: viemDomain, types, primaryType: "TransferWithAuthorization", message });
    expect(ours).toBe(theirs);
    expect(await recoverTypedDataAddress({ domain: viemDomain, types, primaryType: "TransferWithAuthorization", message, signature: ours as `0x${string}` })).toBe(auth.from);
    expect(recoverAuthorizer(domain, auth, ours)).toBe(auth.from);
  });

  it("X13: a change to any field gives another signer", () => {
    const sig = signAuthorization(KEY, domain, auth);
    for (const changed of [{ ...auth, value: "10001" }, { ...auth, to: auth.from }, { ...auth, nonce: `0x${"1".repeat(64)}` }])
      expect(recoverAuthorizer(domain, changed, sig)).not.toBe(auth.from);
    expect(recoverAuthorizer({ ...domain, chainId: 8453 }, auth, sig)).not.toBe(auth.from);
  });

  it("X13: input that is not valid throws, with no key in the message", () => {
    const bad: [string, () => unknown][] = [
      ["short key", () => signAuthorization("0x1234", domain, auth)],
      ["zero key", () => signAuthorization(`0x${"0".repeat(64)}`, domain, auth)],
      ["bad address", () => signAuthorization(KEY, domain, { ...auth, to: "0x1234" })],
      ["negative value", () => signAuthorization(KEY, domain, { ...auth, value: "-1" })],
      ["value too big", () => signAuthorization(KEY, domain, { ...auth, value: (2n ** 256n).toString() })],
      ["short nonce", () => signAuthorization(KEY, domain, { ...auth, nonce: "0x12" })],
      ["bad chain", () => signAuthorization(KEY, { ...domain, chainId: 1.5 }, auth)],
    ];
    for (const [name, fn] of bad) {
      expect(fn, name).toThrow();
      try {
        fn();
      } catch (error) {
        expect(String(error)).not.toContain(KEY.slice(2));
      }
    }
  });

  it("X13: a high-s copy of a signature does not recover", () => {
    const sig = signAuthorization(KEY, domain, auth);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = sig.slice(130) === "1b" ? "1c" : "1b";
    const high = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${v}`;
    expect(() => recoverAuthorizer(domain, auth, high)).toThrow();
  });
});
