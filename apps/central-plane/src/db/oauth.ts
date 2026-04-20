import type { Env } from "../env.js";

export interface OAuthDevice {
  deviceCodeId: string;
  deviceCode: string;
  userCode: string;
  repoSlug: string;
  intervalSec: number;
  expiresAt: string;
  createdAt: string;
  consumed: 0 | 1 | 2;
}

interface Row {
  device_code_id: string;
  device_code: string;
  user_code: string;
  repo_slug: string;
  interval_sec: number;
  expires_at: string;
  created_at: string;
  consumed: number;
}

function rowToRecord(row: Row): OAuthDevice {
  const c = row.consumed;
  return {
    deviceCodeId: row.device_code_id,
    deviceCode: row.device_code,
    userCode: row.user_code,
    repoSlug: row.repo_slug,
    intervalSec: row.interval_sec,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    consumed: (c === 1 ? 1 : c === 2 ? 2 : 0),
  };
}

export async function createDevice(
  env: Env,
  input: {
    deviceCodeId: string;
    deviceCode: string;
    userCode: string;
    repoSlug: string;
    intervalSec: number;
    expiresAt: string;
    createdAt: string;
  },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO oauth_devices (device_code_id, device_code, user_code, repo_slug, interval_sec, expires_at, created_at, consumed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  )
    .bind(
      input.deviceCodeId,
      input.deviceCode,
      input.userCode,
      input.repoSlug,
      input.intervalSec,
      input.expiresAt,
      input.createdAt,
    )
    .run();
}

export async function findDevice(env: Env, deviceCodeId: string): Promise<OAuthDevice | null> {
  const row = await env.DB.prepare("SELECT * FROM oauth_devices WHERE device_code_id = ?")
    .bind(deviceCodeId)
    .first<Row>();
  return row ? rowToRecord(row) : null;
}

export async function markDeviceConsumed(env: Env, deviceCodeId: string, flag: 1 | 2): Promise<void> {
  await env.DB.prepare("UPDATE oauth_devices SET consumed = ? WHERE device_code_id = ?")
    .bind(flag, deviceCodeId)
    .run();
}
