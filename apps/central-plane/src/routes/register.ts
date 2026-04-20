import { Hono } from "hono";
import type { Env } from "../env.js";
import { createInstall, findInstallBySlug } from "../db/installs.js";
import { isValidRepoSlug, newId, sha256Hex } from "../util.js";

export const registerRoutes = new Hono<{ Bindings: Env }>();

/**
 * v0.4-alpha placeholder register. Mints an opaque CONCLAVE_TOKEN that the
 * consumer repo stores as a GitHub secret. The next PR replaces this with
 * the GitHub OAuth flow (`/oauth/github/start` + `/oauth/github/callback`)
 * — the response shape stays stable so `conclave init` doesn't need to
 * change when OAuth lands.
 */
registerRoutes.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { repo?: unknown } | null;
  if (!body || !isValidRepoSlug(body.repo)) {
    return c.json({ error: "body must be { repo: 'owner/name' } with a valid GitHub slug" }, 400);
  }
  const slug = body.repo;
  const existing = await findInstallBySlug(c.env, slug);
  if (existing) {
    return c.json(
      {
        error: "install already exists for this repo",
        id: existing.id,
        hint: "use POST /install/:id/rotate-token once rotation lands (next PR)",
      },
      409,
    );
  }
  const token = `c_placeholder_${newId().slice(2)}`;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const install = await createInstall(c.env, { id: newId(), repoSlug: slug, tokenHash, now });
  return c.json(
    {
      id: install.id,
      repo: install.repoSlug,
      token,
      note: "v0.4-alpha placeholder token. OAuth flow (signed JWT) lands in the next PR — API shape will stay the same.",
    },
    201,
  );
});
