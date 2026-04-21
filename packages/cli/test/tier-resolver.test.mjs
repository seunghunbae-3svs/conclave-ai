import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTierIds } from "../dist/lib/tier-resolver.js";

// ─── Pure domain: no merge, no safety net ───────────────────────────

test("resolveTierIds: resolvedDomain=code pulls from codeDomainCfg only", () => {
  const out = resolveTierIds({
    resolvedDomain: "code",
    codeDomainCfg: {
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
      models: { tier1: {}, tier2: { claude: "claude-opus-4-7" } },
    },
    designDomainCfg: {
      tier1: ["design", "claude"],
      tier2: ["design", "claude"],
    },
  });
  assert.deepEqual(out.tier1Ids, ["claude", "openai", "gemini"]);
  assert.deepEqual(out.tier2Ids, ["claude", "openai"]);
  assert.deepEqual(out.tier2Models, { claude: "claude-opus-4-7" });
});

test("resolveTierIds: resolvedDomain=design pulls from designDomainCfg only", () => {
  const out = resolveTierIds({
    resolvedDomain: "design",
    codeDomainCfg: {
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
    },
    designDomainCfg: {
      tier1: ["design", "claude"],
      tier2: ["design", "claude"],
      models: { tier1: { design: "claude-haiku-4-5" }, tier2: {} },
    },
  });
  assert.deepEqual(out.tier1Ids, ["design", "claude"]);
  assert.deepEqual(out.tier2Ids, ["design", "claude"]);
  assert.deepEqual(out.tier1Models, { design: "claude-haiku-4-5" });
});

// ─── Mixed-domain: the v0.6.2 regression fix ────────────────────────

test("resolveTierIds: resolvedDomain=mixed unions code + design, dedup preserved", () => {
  const out = resolveTierIds({
    resolvedDomain: "mixed",
    codeDomainCfg: {
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
    },
    designDomainCfg: {
      tier1: ["design", "claude"],
      tier2: ["design", "claude"],
    },
  });
  // code first, design-only additions appended ("design" is design-only).
  // With the safety net, "design" is already present so no duplication.
  assert.deepEqual(out.tier1Ids, ["claude", "openai", "gemini", "design"]);
  assert.deepEqual(out.tier2Ids, ["claude", "openai", "design"]);
});

test("resolveTierIds: mixed + stale config (no 'design' in either list) → safety net injects design at tier-1 head", () => {
  // Reproduces the eventbadge#20 bug: pre-v0.5.0-alpha.1 configs had
  // domains.design.tier1 = ["claude","openai","gemini"] without a
  // literal "design" entry. Without the safety net, the merged tier-1
  // would never include DesignAgent and the rendered verdict would
  // silently drop the design section.
  const out = resolveTierIds({
    resolvedDomain: "mixed",
    codeDomainCfg: {
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
    },
    designDomainCfg: {
      // Stale shape — no "design" here.
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
    },
  });
  // Safety net must inject "design" at the head of tier-1.
  assert.equal(out.tier1Ids[0], "design");
  assert.ok(out.tier1Ids.includes("claude"));
  assert.ok(out.tier1Ids.includes("openai"));
  assert.ok(out.tier1Ids.includes("gemini"));
  // Same safety net for tier-2 (non-empty → design always-escalates
  // is the binding verdict).
  assert.equal(out.tier2Ids[0], "design");
});

test("resolveTierIds: mixed with empty tier-2 on both configs → safety net does NOT inject design into tier-2", () => {
  // Tier-1-only mode is a legitimate config; we shouldn't force
  // tier-2 to exist where the user intentionally left it empty.
  const out = resolveTierIds({
    resolvedDomain: "mixed",
    codeDomainCfg: {
      tier1: ["claude", "openai"],
      tier2: [],
    },
    designDomainCfg: {
      tier1: ["claude"],
      tier2: [],
    },
  });
  assert.equal(out.tier1Ids[0], "design");
  assert.deepEqual(out.tier2Ids, []);
});

test("resolveTierIds: mixed with 'design' already in design config (post-PR#84) → no duplication", () => {
  const out = resolveTierIds({
    resolvedDomain: "mixed",
    codeDomainCfg: {
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
    },
    designDomainCfg: {
      // Current default: "design" is first in tier-1.
      tier1: ["design", "claude"],
      tier2: ["design", "claude"],
    },
  });
  // "design" appears exactly once in each tier.
  assert.equal(out.tier1Ids.filter((id) => id === "design").length, 1);
  assert.equal(out.tier2Ids.filter((id) => id === "design").length, 1);
});

test("resolveTierIds: mixed — design model overrides win over code model overrides", () => {
  const out = resolveTierIds({
    resolvedDomain: "mixed",
    codeDomainCfg: {
      tier1: ["claude", "openai"],
      tier2: ["claude", "openai"],
      models: {
        tier1: {},
        tier2: { claude: "claude-opus-4-7", openai: "gpt-5.4" },
      },
    },
    designDomainCfg: {
      tier1: ["design", "claude"],
      tier2: ["design", "claude"],
      models: {
        tier1: { design: "claude-haiku-4-5" },
        // design overrides code's `claude` pick here intentionally.
        tier2: { design: "claude-opus-4-7", claude: "claude-opus-4-7-forced" },
      },
    },
  });
  assert.equal(out.tier1Models.design, "claude-haiku-4-5");
  assert.equal(out.tier2Models.claude, "claude-opus-4-7-forced");
  assert.equal(out.tier2Models.openai, "gpt-5.4");
  assert.equal(out.tier2Models.design, "claude-opus-4-7");
});

// ─── Missing-config edges ───────────────────────────────────────────

test("resolveTierIds: mixed with only codeDomainCfg present → still injects design", () => {
  const out = resolveTierIds({
    resolvedDomain: "mixed",
    codeDomainCfg: {
      tier1: ["claude", "openai"],
      tier2: ["claude"],
    },
    designDomainCfg: undefined,
  });
  assert.equal(out.tier1Ids[0], "design");
  assert.ok(out.tier1Ids.includes("claude"));
  assert.ok(out.tier1Ids.includes("openai"));
  assert.equal(out.tier2Ids[0], "design");
});

test("resolveTierIds: code with missing codeDomainCfg → empty arrays", () => {
  const out = resolveTierIds({
    resolvedDomain: "code",
    codeDomainCfg: undefined,
    designDomainCfg: undefined,
  });
  assert.deepEqual(out.tier1Ids, []);
  assert.deepEqual(out.tier2Ids, []);
});

// ─── Regression: the eventbadge#20 scenario end-to-end ──────────────

test("resolveTierIds: regression — eventbadge#20 stale config + mixed detect → DesignAgent in tier-1", () => {
  // Reproduces the exact .conclaverc.json shape from
  // seunghunbae-3svs/eventbadge as of 2026-04-20.
  const eventbadgeConfig = {
    codeDomainCfg: {
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
      models: { tier1: {}, tier2: { claude: "claude-opus-4-7", openai: "gpt-5.4" } },
    },
    designDomainCfg: {
      // Stale — no "design" entry.
      tier1: ["claude", "openai", "gemini"],
      tier2: ["claude", "openai"],
      models: { tier1: {}, tier2: { claude: "claude-opus-4-7", openai: "gpt-5.4" } },
    },
  };
  const out = resolveTierIds({ resolvedDomain: "mixed", ...eventbadgeConfig });

  // Before the fix: tier1Ids = ["claude", "openai", "gemini"] → no
  // design → DesignAgent never instantiated → renderer drops section.
  // After the fix: "design" is injected at the head.
  assert.ok(
    out.tier1Ids.includes("design"),
    `tier-1 must include "design" for mixed-domain; got ${JSON.stringify(out.tier1Ids)}`,
  );
  assert.ok(
    out.tier2Ids.includes("design"),
    `tier-2 must include "design" for mixed-domain with non-empty tier-2`,
  );
});
