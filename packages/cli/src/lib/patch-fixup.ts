/**
 * v0.13.10 — programmatic patch fixup for worker output.
 *
 * The Anthropic worker reliably miscounts the line counts in
 * `@@ -A,B +C,D @@` hunk headers — typically B is too large
 * (claims more source lines than the body actually contains).
 * `git apply --recount` only recomputes counts when the body is
 * structurally complete; a truncated hunk (B=7 with 5 source
 * lines in body) trips the parser with "corrupt patch at line N"
 * before --recount even gets a chance.
 *
 * Live RC: eventbadge#29 sha 279cb22 cycle 2 emitted
 *   `@@ -14,7 +14,6 @@`
 * with only 5 source lines + 1 added line in the body. Both
 * `git apply --recount` and `patch -p1 --fuzz=3 -F 3` rejected.
 *
 * `recountHunkHeaders()` walks each hunk body, counts the actual
 * source (` ` + `-`) and result (` ` + `+`) lines, and rewrites
 * the header so B and D match the body exactly. Idempotent for
 * already-correct patches. Does NOT touch the start line A — the
 * fuzz fallback in autofix.ts handles modest A offsets.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Rewrite every `@@ -A,B +C,D @@` header so B equals the count of
 * source-side lines (` ` + `-`) and D equals the count of
 * result-side lines (` ` + `+`) in the hunk body that follows.
 *
 * Lines that don't fit the unified-diff line shape (anything but
 * ` `, `-`, `+`, `\`) end the body walk so we don't run past a
 * hunk into the next file diff.
 */
export function recountHunkHeaders(patch: string): string {
  if (!patch || !patch.includes("@@")) return patch;
  const lines = patch.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = line.match(HUNK_HEADER_RE);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    const a = m[1];
    const c = m[3];
    const suffix = m[5] ?? "";
    // Walk the hunk body, counting source and result lines.
    let bodyB = 0;
    let bodyD = 0;
    let j = i + 1;
    while (j < lines.length) {
      const bl = lines[j] ?? "";
      // Stop at the next hunk / file boundary.
      if (bl.startsWith("@@ ") || bl.startsWith("diff --git") ||
          bl.startsWith("--- ") || bl.startsWith("+++ ") ||
          bl.startsWith("Index: ") || bl.startsWith("index ")) {
        break;
      }
      // Count by leading character. `\` is the "no newline at end of
      // file" marker — neither source nor result, just metadata.
      if (bl.startsWith(" ")) { bodyB++; bodyD++; j++; continue; }
      if (bl.startsWith("-")) { bodyB++; j++; continue; }
      if (bl.startsWith("+")) { bodyD++; j++; continue; }
      if (bl.startsWith("\\")) { j++; continue; }
      // Empty trailing line of the patch — end of body.
      if (bl === "") { j++; break; }
      // Anything else: unrecognised; stop without consuming.
      break;
    }
    out.push(`@@ -${a},${bodyB} +${c},${bodyD} @@${suffix}`);
    for (let k = i + 1; k < j; k++) {
      const ln = lines[k];
      if (ln !== undefined) out.push(ln);
    }
    i = j;
  }
  return out.join("\n");
}
