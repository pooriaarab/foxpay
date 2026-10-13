// What the approval card shows for a value: the text a human reads before
// Approve. Failure modes V1-V4 in docs/failure-modes.md. The same function
// is in foxgate's src/visible.ts (foxgate#67).
//
// The token binds the exact action, so each value must read as itself.
// Control characters (Cc), format characters (Cf: bidi controls, zero
// width, soft hyphen, BOM) and the line and paragraph separators can make
// one string look like another, so each one shows as a visible escape.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const escape = (text: string) => text.replace(HIDDEN, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);

/** A value as the card shows it: a string as it is (`""` when empty), anything else as its JSON. */
export function visibleValue(value: unknown): string {
  if (typeof value === "string") return value === "" ? '""' : escape(value);
  return escape(JSON.stringify(value) ?? String(value));
}
