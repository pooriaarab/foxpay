// The minimal EIP-712 signing that x402 "exact" on EVM needs: one struct,
// EIP-3009 TransferWithAuthorization, signed with secp256k1 (failure mode X13).
// It uses @noble/curves and @noble/hashes (MIT, audited) and nothing else.
//
// digest = keccak256(0x19 0x01 || domainSeparator || structHash)
// domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(name), keccak256(version), chainId, verifyingContract))
// structHash = keccak256(abi.encode(TYPEHASH, from, to, value, validAfter, validBefore, nonce))
// The signature is r || s || v, with v = 27 + recovery bit and a low s.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** The token contract that checks the signature. For USDC on Base Sepolia: name "USDC", version "2", chainId 84532. */
export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** EIP-3009 TransferWithAuthorization. Numbers are decimal strings, as in x402. */
export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

const text = new TextEncoder();
const keccak = (bytes: Uint8Array) => keccak_256(bytes);
const DOMAIN_TYPEHASH = keccak(text.encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const TYPEHASH = keccak(text.encode("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));
const MAX_UINT = 2n ** 256n - 1n;

// Errors name the field, never its value, so a key cannot end up in a message.
function bytesOf(hex: unknown, length: number, field: string): Uint8Array {
  if (typeof hex !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(hex)) throw new TypeError(`${field} must be 0x and ${length * 2} hex digits.`);
  return Uint8Array.from(hex.slice(2).match(/../g)!, (b) => parseInt(b, 16));
}
function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31, v = value; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}
function uint(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) > MAX_UINT) throw new TypeError(`${field} must be a decimal uint256.`);
  return word(BigInt(value));
}
const address = (value: unknown, field: string) => {
  const out = new Uint8Array(32);
  out.set(bytesOf(value, 20, field), 12);
  return out;
};
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const toHex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The EIP-55 mixed-case form of an address. */
export function checksumAddress(value: string): string {
  const lower = toHex(bytesOf(value, 20, "address")).slice(2);
  const hash = toHex(keccak(text.encode(lower))).slice(2);
  return `0x${[...lower].map((c, i) => (parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

function domainSeparator(domain: TokenDomain): Uint8Array {
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0) throw new TypeError("chainId must be a positive whole number.");
  if (typeof domain.name !== "string" || typeof domain.version !== "string") throw new TypeError("name and version must be strings.");
  return keccak(concat(DOMAIN_TYPEHASH, keccak(text.encode(domain.name)), keccak(text.encode(domain.version)), word(BigInt(domain.chainId)), address(domain.verifyingContract, "verifyingContract")));
}

/** The 32-byte EIP-712 digest that the wallet signs. */
export function authorizationDigest(domain: TokenDomain, auth: Authorization): Uint8Array {
  const struct = keccak(concat(TYPEHASH, address(auth.from, "from"), address(auth.to, "to"), uint(auth.value, "value"), uint(auth.validAfter, "validAfter"), uint(auth.validBefore, "validBefore"), bytesOf(auth.nonce, 32, "nonce")));
  return keccak(concat(Uint8Array.of(0x19, 0x01), domainSeparator(domain), struct));
}

function secretKey(privateKey: string): Uint8Array {
  const key = bytesOf(privateKey, 32, "The wallet key");
  if (!secp256k1.utils.isValidSecretKey(key)) throw new TypeError("The wallet key is not a valid secp256k1 key.");
  return key;
}
const addressOfPublic = (publicKey: Uint8Array) => checksumAddress(toHex(keccak(publicKey.slice(1)).slice(12)));

/** The address of a wallet key. */
export function addressOf(privateKey: string): string {
  return addressOfPublic(secp256k1.getPublicKey(secretKey(privateKey), false));
}

/** Sign the authorization. Returns 0x and 130 hex digits: r, s, v. */
export function signAuthorization(privateKey: string, domain: TokenDomain, auth: Authorization): string {
  const digest = authorizationDigest(domain, auth);
  const sig = secp256k1.sign(digest, secretKey(privateKey), { prehash: false, lowS: true, format: "recovered" });
  return toHex(concat(sig.slice(1), Uint8Array.of(27 + sig[0]!)));
}

/** The address that signed the authorization. Throws for a signature that is not valid, also for a high s. */
export function recoverAuthorizer(domain: TokenDomain, auth: Authorization, signature: string): string {
  const sig = bytesOf(signature, 65, "signature");
  const v = sig[64]!;
  if (v !== 27 && v !== 28) throw new TypeError("v must be 27 or 28.");
  const digest = authorizationDigest(domain, auth);
  const recovered = concat(Uint8Array.of(v - 27), sig.slice(0, 64));
  const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  // recoverPublicKey accepts a high s. EIP-2 and USDC do not, so refuse it here.
  if (!secp256k1.verify(sig.slice(0, 64), digest, publicKey, { prehash: false, lowS: true })) throw new TypeError("The signature is not valid.");
  return addressOfPublic(secp256k1.Point.fromBytes(publicKey).toBytes(false));
}
