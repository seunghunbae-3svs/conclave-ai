import { Hono } from "hono";
import type { Env } from "../env.js";
import { isValidRepoSlug, newId, sha256Hex } from "../util.js";
import { createDevice, findDevice, markDeviceConsumed } from "../db/oauth.js";
import { createInstall, findInstallBySlug } from "../db/installs.js";
import { setGithubAccessToken } from "../db/telegram.js";
import { fetchRepoPermissions, pollDeviceToken, requestDeviceCode, type FetchLike } from "../github.js";

/**
 * Factory so tests can inject a mock fetch; production gets globalThis.fetch.
 * v0.7.3 — default now binds globalThis to avoid the "Illegal
 * invocation" fault on Workers (see router.ts for context).
 */
export function createOAuthRoutes(
  fetchImpl: FetchLike = fetch.bind(globalThis) as FetchLike,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/oauth/device/start", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { repo?: unknown } | null;
    if (!body || !isValidRepoSlug(body.repo)) {
      return c.json({ error: "body must be { repo: 'owner/name' }" }, 400);
    }
    const clientId = c.env.GITHUB_CLIENT_ID;
    if (!clientId || clientId.startsWith("REPLACE_WITH_")) {
      return c.json(
        {
          error: "central plane not configured — GITHUB_CLIENT_ID unset. Register an OAuth App first; see README.",
        },
        503,
      );
    }

    let gh;
    try {
      gh = await requestDeviceCode(clientId, fetchImpl);
    } catch (err) {
      return c.json({ error: `upstream: ${(err as Error).message}` }, 502);
    }

    const deviceCodeId = newId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + gh.expires_in * 1000).toISOString();
    await createDevice(c.env, {
      deviceCodeId,
      deviceCode: gh.device_code,
      userCode: gh.user_code,
      repoSlug: body.repo,
      intervalSec: gh.interval,
      expiresAt,
      createdAt: now.toISOString(),
    });

    return c.json({
      device_code_id: deviceCodeId,
      user_code: gh.user_code,
      verification_uri: gh.verification_uri,
      interval_sec: gh.interval,
      expires_at: expiresAt,
    });
  });

  app.post("/oauth/device/poll", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { device_code_id?: unknown } | null;
    if (!body || typeof body.device_code_id !== "string") {
      return c.json({ error: "body must be { device_code_id: string }" }, 400);
    }

    const device = await findDevice(c.env, body.device_code_id);
    if (!device) return c.json({ error: "device_code_id not found" }, 404);

    if (device.consumed === 1) return c.json({ status: "already_succeeded" });
    if (device.consumed === 2) return c.json({ status: "expired" });
    if (new Date(device.expiresAt).getTime() < Date.now()) {
      await markDeviceConsumed(c.env, device.deviceCodeId, 2);
      return c.json({ status: "expired" });
    }

    const clientId = c.env.GITHUB_CLIENT_ID;
    if (!clientId) return c.json({ error: "central plane not configured" }, 503);

    const poll = await pollDeviceToken(clientId, device.deviceCode, fetchImpl);

    switch (poll.kind) {
      case "pending":
        return c.json({ status: "pending", interval_sec: device.intervalSec });
      case "slow_down":
        return c.json({ status: "slow_down", interval_sec: device.intervalSec + 5 });
      case "expired":
        await markDeviceConsumed(c.env, device.deviceCodeId, 2);
        return c.json({ status: "expired" });
      case "denied":
        await markDeviceConsumed(c.env, device.deviceCodeId, 2);
        return c.json({ status: "denied" });
      case "error":
        return c.json({ status: "error", message: poll.message }, 500);
      case "success": {
        // Verify the authorising user actually has write access to the repo they
        // claimed. Repo owner mismatch / no-push-rights → deny hard.
        const perms = await fetchRepoPermissions(device.repoSlug, poll.accessToken, fetchImpl).catch(
          () => null,
        );
        if (!perms || (!perms.admin && !perms.push)) {
          await markDeviceConsumed(c.env, device.deviceCodeId, 2);
          return c.json(
            { status: "denied", reason: "authorised user has no push access to the repo they registered" },
            403,
          );
        }

        // Mint CONCLAVE_TOKEN (opaque). Store hash only — raw token is in the
        // response once, never retrievable again.
        const conclaveToken = `c_${newId().slice(2)}_${crypto.randomUUID().replace(/-/g, "")}`;
        const tokenHash = await sha256Hex(conclaveToken);
        const now = new Date().toISOString();

        const existing = await findInstallBySlug(c.env, device.repoSlug);
        let installId: string;
        if (existing) {
          // Rotate: update token_hash + last_seen_at in place. Install id stays stable.
          await c.env.DB.prepare("UPDATE installs SET token_hash = ?, last_seen_at = ? WHERE id = ?")
            .bind(tokenHash, now, existing.id)
            .run();
          installId = existing.id;
        } else {
          const fresh = await createInstall(c.env, {
            id: newId(),
            repoSlug: device.repoSlug,
            tokenHash,
            now,
          });
          installId = fresh.id;
        }

        // Store the GitHub access_token so the central bot can fire
        // repository_dispatch on this repo when the user clicks a button
        // in Telegram. Token is stored plaintext for v0.4-alpha (see
        // migration 0003 for the encryption upgrade note).
        await setGithubAccessToken(c.env, installId, poll.accessToken, poll.scope, now);

        await markDeviceConsumed(c.env, device.deviceCodeId, 1);

        return c.json({
          status: "success",
          token: conclaveToken,
          repo: device.repoSlug,
          rotated: Boolean(existing),
          note: "CONCLAVE_TOKEN — set this as the GitHub repo secret CONCLAVE_TOKEN immediately; it is not retrievable.",
        });
      }
    }
  });

  return app;
}
