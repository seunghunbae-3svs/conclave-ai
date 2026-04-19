import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatforms } from "../dist/lib/platform-factory.js";

function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("buildPlatforms: no env → all platforms except deployment-status skipped", async () => {
  await withEnv(
    {
      VERCEL_TOKEN: null,
      NETLIFY_TOKEN: null,
      NETLIFY_SITE_ID: null,
      CLOUDFLARE_API_TOKEN: null,
      CLOUDFLARE_ACCOUNT_ID: null,
      CLOUDFLARE_PROJECT_NAME: null,
      RAILWAY_API_TOKEN: null,
      RAILWAY_PROJECT_ID: null,
    },
    async () => {
      const out = await buildPlatforms(["vercel", "netlify", "cloudflare", "railway", "deployment-status"]);
      // deployment-status has no env requirement — always resolves
      assert.equal(out.platforms.length, 1);
      assert.equal(out.platforms[0].id, "deployment-status");
      assert.equal(out.skipped.length, 4);
      const skippedIds = out.skipped.map((s) => s.id);
      assert.deepEqual(skippedIds.sort(), ["cloudflare", "netlify", "railway", "vercel"]);
    },
  );
});

test("buildPlatforms: Vercel instantiated when VERCEL_TOKEN set", async () => {
  await withEnv(
    {
      VERCEL_TOKEN: "fake-token",
      NETLIFY_TOKEN: null,
      CLOUDFLARE_API_TOKEN: null,
    },
    async () => {
      const out = await buildPlatforms(["vercel"]);
      assert.equal(out.platforms.length, 1);
      assert.equal(out.platforms[0].id, "vercel");
      assert.equal(out.skipped.length, 0);
    },
  );
});

test("buildPlatforms: Netlify needs BOTH token + siteId", async () => {
  await withEnv({ NETLIFY_TOKEN: "t", NETLIFY_SITE_ID: null }, async () => {
    const out = await buildPlatforms(["netlify"]);
    assert.equal(out.platforms.length, 0);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /SITE_ID/);
  });
  await withEnv({ NETLIFY_TOKEN: "t", NETLIFY_SITE_ID: "s" }, async () => {
    const out = await buildPlatforms(["netlify"]);
    assert.equal(out.platforms.length, 1);
  });
});

test("buildPlatforms: Cloudflare needs all three envs", async () => {
  await withEnv(
    {
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_PROJECT_NAME: null,
    },
    async () => {
      const out = await buildPlatforms(["cloudflare"]);
      assert.equal(out.platforms.length, 0);
      assert.equal(out.skipped.length, 1);
    },
  );
  await withEnv(
    {
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_PROJECT_NAME: "proj",
    },
    async () => {
      const out = await buildPlatforms(["cloudflare"]);
      assert.equal(out.platforms.length, 1);
    },
  );
});

test("buildPlatforms: Railway needs BOTH token + projectId", async () => {
  await withEnv({ RAILWAY_API_TOKEN: "t", RAILWAY_PROJECT_ID: null }, async () => {
    const out = await buildPlatforms(["railway"]);
    assert.equal(out.platforms.length, 0);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /PROJECT_ID/);
  });
  await withEnv({ RAILWAY_API_TOKEN: "t", RAILWAY_PROJECT_ID: "proj" }, async () => {
    const out = await buildPlatforms(["railway"]);
    assert.equal(out.platforms.length, 1);
    assert.equal(out.platforms[0].id, "railway");
  });
});

test("buildPlatforms: deployment-status has no env requirement", async () => {
  await withEnv(
    {
      VERCEL_TOKEN: null,
      NETLIFY_TOKEN: null,
      CLOUDFLARE_API_TOKEN: null,
    },
    async () => {
      const out = await buildPlatforms(["deployment-status"]);
      assert.equal(out.platforms.length, 1);
      assert.equal(out.platforms[0].id, "deployment-status");
    },
  );
});

test("buildPlatforms: preserves order of input ids", async () => {
  await withEnv(
    {
      VERCEL_TOKEN: "t",
      NETLIFY_TOKEN: "t",
      NETLIFY_SITE_ID: "s",
    },
    async () => {
      const out = await buildPlatforms(["netlify", "vercel", "deployment-status"]);
      const ids = out.platforms.map((p) => p.id);
      assert.deepEqual(ids, ["netlify", "vercel", "deployment-status"]);
    },
  );
});
