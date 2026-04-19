# @ai-conclave/visual-review

Before/after visual review for Ai-Conclave. Captures PNG screenshots of
a PR's deployed preview (before SHA + after SHA), runs pixel diff, saves
all three PNGs + metadata to disk.

Decision #15: odiff is the intended fast path for v2.x; pixelmatch
(pure JS) ships as the default for a simple install.

## Install

```bash
pnpm add @ai-conclave/visual-review @ai-conclave/core
pnpm add playwright           # peer dep; install chromium separately
npx playwright install chromium
```

## Usage

```ts
import { runVisualReview } from "@ai-conclave/visual-review";
import { VercelPlatform } from "@ai-conclave/platform-vercel";
import { NetlifyPlatform } from "@ai-conclave/platform-netlify";

const result = await runVisualReview({
  repo: "acme/app",
  beforeSha: "abc123",
  afterSha: "def456",
  platforms: [new VercelPlatform(), new NetlifyPlatform()],
  captureOptions: { width: 1440, height: 900, fullPage: true },
  diffOptions: { threshold: 0.1 },
  waitSeconds: 120, // allow deploy to finish building
});

console.log(result.severity);           // "minor" | "significant" | "major" | ...
console.log(result.diff.diffRatio);     // 0.0023
console.log(result.paths.diff);         // .conclave/visual/def456/diff.png
```

## Severity bands

| Ratio | Label | Meaning |
|---|---|---|
| < 0.05% | `identical` | noise-only change |
| < 1% | `minor` | small area touched (a button, an icon) |
| < 10% | `significant` | a section reworked |
| < 50% | `major` | bulk change across the page |
| ≥ 50% | `total-rewrite` | different page entirely |

## Pluggable engines

```ts
// Swap in odiff for 6-8× speed
runVisualReview({ …, diff: new OdiffAdapter() });

// Swap in Puppeteer if Playwright isn't available
runVisualReview({ …, capture: new PuppeteerCapture() });
```

Both `ScreenshotCapture` and `VisualDiff` are interfaces — any
implementation works.

## Output

```
.conclave/visual/<afterSha>/
├── before.png   # full-page screenshot at beforeSha
├── after.png    # full-page screenshot at afterSha
└── diff.png     # pixelmatch output (red = changed)
```
