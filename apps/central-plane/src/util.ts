/**
 * CUID-like identifier generator. Prefix `c_` to mark conclave-owned
 * records across log / DB scrubbing. Time component is sortable; random
 * tail is 8 bytes of crypto randomness which is overkill for uniqueness
 * and useful for defeating ID guessing.
 */
export function newId(): string {
  const time = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `c_${time}_${rand}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Validate that a string looks like "owner/name" — no path traversal, no spaces. */
export function isValidRepoSlug(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\/[A-Za-z0-9_.-]{1,100}$/.test(s) &&
    !s.includes("..")
  );
}
