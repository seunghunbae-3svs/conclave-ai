import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generatePlainSummary,
  computePlainSummaryKey,
  parsePlainSummaryText,
  InMemoryPlainSummaryCache,
} from "../dist/index.js";

/** Captures all calls to summarize(); returns a scripted reply. */
function fakeLlm(reply) {
  const calls = [];
  return {
    calls,
    summarize: async ({ system, user }) => {
      calls.push({ system, user });
      return typeof reply === "function" ? reply({ system, user }) : reply;
    },
  };
}

function baseInput(overrides = {}) {
  return {
    mode: "review",
    verdict: "rework",
    subject: { repo: "seunghunbae-3svs/eventbadge", prNumber: 20, sha: "abc123def456" },
    changes: {
      filesChanged: 4,
      linesAdded: 120,
      linesRemoved: 30,
      topFiles: ["src/components/Badge.tsx", "src/pages/Event.tsx"],
    },
    blockers: [
      {
        severity: "major",
        category: "accessibility",
        file: "src/components/Badge.tsx",
        oneLine: "Badge color contrast falls below WCAG AA on the event page",
      },
      {
        severity: "minor",
        category: "contrast",
        oneLine: "Button hover state near invisible on light backgrounds",
      },
    ],
    locale: "en",
    ...overrides,
  };
}

test("generatePlainSummary returns three sections for a review input", async () => {
  const reply = [
    "WHAT: This change updates four files on the event badge page, mostly styling tweaks.",
    "",
    "VERDICT: There are two visual issues to fix before the page is ready for users.",
    "",
    "NEXT: Tighten the badge color contrast, then re-open the preview to confirm.",
  ].join("\n");
  const llm = fakeLlm(reply);
  const result = await generatePlainSummary(baseInput(), { llm });
  assert.ok(result.whatChanged.includes("event badge"));
  assert.ok(result.verdictInPlain.includes("issues to fix"));
  assert.ok(result.nextAction.includes("re-open"));
  assert.equal(result.locale, "en");
  assert.ok(result.raw.length > 0);
});

test("cache hit avoids a second LLM call for identical input", async () => {
  const reply = "WHAT: foo.\n\nVERDICT: bar.\n\nNEXT: baz.";
  const llm = fakeLlm(reply);
  const cache = new InMemoryPlainSummaryCache();
  const input = baseInput();
  await generatePlainSummary(input, { llm, cache });
  await generatePlainSummary(input, { llm, cache });
  assert.equal(llm.calls.length, 1, "second call should be a cache hit");
});

test("cache miss on different blocker set", async () => {
  const reply = "WHAT: foo.\n\nVERDICT: bar.\n\nNEXT: baz.";
  const llm = fakeLlm(reply);
  const cache = new InMemoryPlainSummaryCache();
  const input = baseInput();
  await generatePlainSummary(input, { llm, cache });
  // Different blocker list -> different hash -> cache miss.
  const input2 = baseInput({
    blockers: [{ severity: "major", category: "security", oneLine: "something else" }],
  });
  await generatePlainSummary(input2, { llm, cache });
  assert.equal(llm.calls.length, 2);
});

test("ko locale produces text with Hangul characters", async () => {
  const reply = [
    "WHAT: 이번 변경은 이벤트 배지 페이지의 대비와 색상을 다듬었다.",
    "VERDICT: 배지 색 대비가 접근성 기준 아래라서 두 가지를 고쳐야 한다.",
    "NEXT: 대비를 올리고 미리보기에서 다시 확인한다.",
  ].join("\n\n");
  const llm = fakeLlm(reply);
  const result = await generatePlainSummary(baseInput({ locale: "ko" }), { llm });
  const hangul = /[가-힣]/;
  assert.ok(hangul.test(result.whatChanged));
  assert.ok(hangul.test(result.verdictInPlain));
  assert.ok(hangul.test(result.nextAction));
  assert.equal(result.locale, "ko");
});

test("en locale produces ASCII-dominant text", async () => {
  const reply = [
    "WHAT: This change updates four styling files.",
    "VERDICT: Two small visual issues need fixing.",
    "NEXT: Tighten contrast and re-check.",
  ].join("\n\n");
  const llm = fakeLlm(reply);
  const result = await generatePlainSummary(baseInput(), { llm });
  // At least the WHAT sentence should be entirely ASCII.
  assert.ok(/^[\x00-\x7F]+$/.test(result.whatChanged));
});

test("jargon filter strips forbidden words the LLM slipped in", async () => {
  // LLM accidentally used forbidden jargon.
  const reply = [
    "WHAT: This tier-2 change touches four files across the UI.",
    "VERDICT: The council says rework — one blocker and one severity flag remain.",
    "NEXT: Fix the rework notes, then ship.",
  ].join("\n\n");
  const llm = fakeLlm(reply);
  const result = await generatePlainSummary(baseInput(), { llm });
  // None of the forbidden words should remain, case-insensitive, whole-word.
  const forbidden = ["tier", "blocker", "severity", "council", "verdict", "rework"];
  const all = [result.whatChanged, result.verdictInPlain, result.nextAction].join(" ").toLowerCase();
  for (const w of forbidden) {
    const re = new RegExp(`\\b${w}\\b`, "i");
    assert.ok(!re.test(all), `found jargon "${w}" in: ${all}`);
  }
});

test("approve verdict + zero blockers yields a 'no issues' style summary", async () => {
  const reply = [
    "WHAT: This change tweaks two styling files on the landing page.",
    "VERDICT: Looks good — nothing to fix.",
    "NEXT: Merge when ready.",
  ].join("\n\n");
  const llm = fakeLlm(reply);
  const input = baseInput({ verdict: "approve", blockers: [] });
  const result = await generatePlainSummary(input, { llm });
  // Confirm the user prompt signals no issues.
  assert.ok(llm.calls[0].user.includes("issues_found: none"));
  assert.ok(result.verdictInPlain.length > 0);
});

test("review mode passes change metadata into the user prompt", async () => {
  const reply = "WHAT: x.\n\nVERDICT: y.\n\nNEXT: z.";
  const llm = fakeLlm(reply);
  await generatePlainSummary(baseInput(), { llm });
  const user = llm.calls[0].user;
  assert.ok(user.includes("mode: review"));
  assert.ok(user.includes("files"));
  assert.ok(user.includes("Badge.tsx"));
});

test("audit mode passes scope metadata into the user prompt", async () => {
  const reply = "WHAT: x.\n\nVERDICT: y.\n\nNEXT: z.";
  const llm = fakeLlm(reply);
  const auditInput = {
    mode: "audit",
    verdict: "rework",
    subject: { repo: "owner/repo", sha: "deadbeef" },
    scope: { filesAudited: 40, filesInScope: 128, categories: ["ui", "code"] },
    blockers: [],
    locale: "en",
  };
  await generatePlainSummary(auditInput, { llm });
  const user = llm.calls[0].user;
  assert.ok(user.includes("mode: audit"));
  assert.ok(user.includes("audit_scope: 40 files audited of 128"));
  assert.ok(user.includes("ui, code"));
});

test("system prompt explicitly forbids jargon words", async () => {
  const reply = "WHAT: x.\n\nVERDICT: y.\n\nNEXT: z.";
  const llm = fakeLlm(reply);
  await generatePlainSummary(baseInput(), { llm });
  const sys = llm.calls[0].system;
  for (const w of ["tier", "blocker", "severity", "council", "verdict"]) {
    assert.ok(sys.toLowerCase().includes(w), `system prompt missing banned-word ref: ${w}`);
  }
});

test("computePlainSummaryKey is stable across blocker order permutations", async () => {
  const a = baseInput();
  const b = baseInput({
    blockers: [a.blockers[1], a.blockers[0]], // reversed
  });
  const keyA = await computePlainSummaryKey(a);
  const keyB = await computePlainSummaryKey(b);
  assert.equal(keyA, keyB, "blocker order must not bust cache");
});

test("parsePlainSummaryText tolerates lowercase prefixes", async () => {
  const raw = [
    "what: first paragraph explaining the change.",
    "",
    "verdict: second paragraph — the call.",
    "",
    "next: third paragraph with the next step.",
  ].join("\n");
  const parsed = parsePlainSummaryText(raw, "en");
  assert.ok(parsed.whatChanged.startsWith("first"));
  assert.ok(parsed.verdictInPlain.startsWith("second"));
  assert.ok(parsed.nextAction.startsWith("third"));
});

test("parsePlainSummaryText falls back when prefixes are missing", async () => {
  const raw = ["first paragraph.", "", "second paragraph.", "", "third paragraph."].join("\n");
  const parsed = parsePlainSummaryText(raw, "en");
  assert.equal(parsed.whatChanged, "first paragraph.");
  assert.equal(parsed.verdictInPlain, "second paragraph.");
  assert.equal(parsed.nextAction, "third paragraph.");
});

test("full-report URL is appended to raw when supplied", async () => {
  const reply = "WHAT: a.\n\nVERDICT: b.\n\nNEXT: c.";
  const llm = fakeLlm(reply);
  const result = await generatePlainSummary(baseInput(), {
    llm,
    fullReportUrl: "https://github.com/owner/repo/pull/20",
  });
  assert.ok(result.raw.includes("https://github.com/owner/repo/pull/20"));
});
