// Failure modes V1-V4 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { visibleValue } from "../src/index.js";

const esc = (c: string) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`;

describe("visibleValue", () => {
  it("V1: shows bidi controls as escapes, so a reversed payee cannot pass for another", () => {
    expect(visibleValue("0x2096\u202E93Bc")).toBe("0x2096⟨U+202E⟩93Bc");
    for (const c of ["\u202A", "\u202B", "\u202C", "\u202D", "\u2066", "\u2067", "\u2068", "\u2069"]) expect(visibleValue(`a${c}b`)).toBe(`a${esc(c)}b`);
  });

  it("V2: shows invisible characters as escapes", () => {
    expect(visibleValue("shop.exam\u200Bple.com")).toBe("shop.exam⟨U+200B⟩ple.com");
    for (const c of ["\u200C", "\u200D", "\u200E", "\u200F", "\u2060", "\uFEFF", "\u00AD"]) expect(visibleValue(c)).toBe(esc(c));
  });

  it("V3: shows control characters and line separators as escapes", () => {
    expect(visibleValue("order\n1042")).toBe("order⟨U+000A⟩1042");
    expect(visibleValue("a\u0000b\u007Fc\u0085d\u2028e\u2029f\tg")).toBe(`a${esc("\u0000")}b${esc("\u007F")}c${esc("\u0085")}d${esc("\u2028")}e${esc("\u2029")}f${esc("\t")}g`);
  });

  it("V4: shows a string as it is and anything else as its JSON", () => {
    expect(visibleValue("shop.example.com")).toBe("shop.example.com");
    expect(visibleValue("")).toBe('""');
    expect(visibleValue(0)).toBe("0");
    expect(visibleValue(null)).toBe("null");
    expect(visibleValue(undefined)).toBe("undefined");
    expect(visibleValue({ url: "x\u202Ey" })).toBe('{"url":"x⟨U+202E⟩y"}');
  });
});
