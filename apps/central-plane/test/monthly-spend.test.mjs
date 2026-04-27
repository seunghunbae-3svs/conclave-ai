import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonthlySpend, readMonthlySpend } from "../dist/db/installs.js";

/**
 * v0.13.20 (H1 #5) — monthly cost cap unit tests.
 *
 * Hermetic: drives addMonthlySpend / readMonthlySpend with a stub
 * D1 implementation. Covers the 4 critical behaviours:
 *   1. accumulates within the same month
 *   2. rolls over on new month boundary
 *   3. degrades gracefully when migration 0008 isn't applied
 *   4. ignores invalid deltas (zero, negative, NaN)
 */

function makeMockDb({ rows = [], throwOnSelect = false, throwOnUpdate = false } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      let bound = [];
      return {
        bind: (...args) => {
          bound = args;
          return {
            async first() {
              if (throwOnSelect) throw new Error("no such column: monthly_spend_usd");
              if (/SELECT.*FROM installs WHERE id/i.test(sql)) {
                const id = bound[0];
                const row = rows.find((r) => r.id === id);
                return row
                  ? {
                      monthly_spend_usd: row.monthly_spend_usd,
                      monthly_spend_cap_usd: row.monthly_spend_cap_usd,
                      monthly_spend_period_start: row.monthly_spend_period_start,
                    }
                  : null;
              }
              return null;
            },
            async run() {
              if (throwOnUpdate) throw new Error("write failed");
              writes.push({ sql, bound });
              if (/UPDATE installs SET monthly_spend_usd/i.test(sql)) {
                const [newSpend, newPeriod, id] = bound;
                const row = rows.find((r) => r.id === id);
                if (row) {
                  row.monthly_spend_usd = newSpend;
                  row.monthly_spend_period_start = newPeriod;
                }
              }
              return { success: true };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

const apr2026 = new Date("2026-04-15T12:00:00Z");
const may2026 = new Date("2026-05-02T08:00:00Z");

// ---- readMonthlySpend ---------------------------------------------------

test("readMonthlySpend: returns existing values from the row", async () => {
  const db = makeMockDb({
    rows: [{
      id: "c_inst",
      monthly_spend_usd: 12.5,
      monthly_spend_cap_usd: 50,
      monthly_spend_period_start: "2026-04-01",
    }],
  });
  const env = { DB: db };
  const r = await readMonthlySpend(env, "c_inst");
  assert.deepEqual(r, { usd: 12.5, capUsd: 50, periodStart: "2026-04-01" });
});

test("readMonthlySpend: degrades to null when migration 0008 not applied (column missing)", async () => {
  const db = makeMockDb({ throwOnSelect: true });
  const env = { DB: db };
  const r = await readMonthlySpend(env, "c_inst");
  assert.equal(r, null, "must return null on missing-column error so /review/notify stays operational");
});

test("readMonthlySpend: returns null for unknown install", async () => {
  const db = makeMockDb({ rows: [] });
  const r = await readMonthlySpend({ DB: db }, "c_unknown");
  assert.equal(r, null);
});

// ---- addMonthlySpend ----------------------------------------------------

test("addMonthlySpend: accumulates within the same calendar month", async () => {
  const db = makeMockDb({
    rows: [{
      id: "c_inst",
      monthly_spend_usd: 5.0,
      monthly_spend_cap_usd: 50,
      monthly_spend_period_start: "2026-04-01",
    }],
  });
  const r = await addMonthlySpend({ DB: db }, "c_inst", 1.5, apr2026);
  assert.deepEqual(r, { newSpendUsd: 6.5, capUsd: 50, rolledOver: false });
  // Persisted to DB.
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].bound[0], 6.5);
  assert.equal(db.writes[0].bound[1], "2026-04-01");
});

test("addMonthlySpend: rolls over on new calendar month — old usd reset", async () => {
  const db = makeMockDb({
    rows: [{
      id: "c_inst",
      monthly_spend_usd: 47.0,
      monthly_spend_cap_usd: 50,
      monthly_spend_period_start: "2026-04-01",
    }],
  });
  const r = await addMonthlySpend({ DB: db }, "c_inst", 0.21, may2026);
  assert.equal(r.rolledOver, true);
  assert.equal(r.newSpendUsd, 0.21, "delta replaces old spend on rollover, not adds to it");
  assert.equal(db.writes[0].bound[1], "2026-05-01");
});

test("addMonthlySpend: first call (periodStart=null) treats as fresh period", async () => {
  const db = makeMockDb({
    rows: [{
      id: "c_inst",
      monthly_spend_usd: 0,
      monthly_spend_cap_usd: 50,
      monthly_spend_period_start: null,
    }],
  });
  const r = await addMonthlySpend({ DB: db }, "c_inst", 0.21, apr2026);
  assert.equal(r.rolledOver, true, "null period must trigger rollover (no prior period to compare)");
  assert.equal(r.newSpendUsd, 0.21);
});

test("addMonthlySpend: invalid delta (zero / negative / NaN) → null no-op", async () => {
  const db = makeMockDb({ rows: [{ id: "c_inst", monthly_spend_usd: 0, monthly_spend_cap_usd: 50, monthly_spend_period_start: null }] });
  const env = { DB: db };
  assert.equal(await addMonthlySpend(env, "c_inst", 0, apr2026), null);
  assert.equal(await addMonthlySpend(env, "c_inst", -1, apr2026), null);
  assert.equal(await addMonthlySpend(env, "c_inst", NaN, apr2026), null);
  assert.equal(db.writes.length, 0, "invalid delta must not write to DB");
});

test("addMonthlySpend: graceful null on read failure (migration not applied)", async () => {
  const db = makeMockDb({ throwOnSelect: true });
  const r = await addMonthlySpend({ DB: db }, "c_inst", 0.21, apr2026);
  assert.equal(r, null);
  assert.equal(db.writes.length, 0);
});

test("addMonthlySpend: graceful null on write failure", async () => {
  const db = makeMockDb({
    rows: [{ id: "c_inst", monthly_spend_usd: 0, monthly_spend_cap_usd: 50, monthly_spend_period_start: null }],
    throwOnUpdate: true,
  });
  const r = await addMonthlySpend({ DB: db }, "c_inst", 0.21, apr2026);
  assert.equal(r, null, "write failure must return null so the caller can degrade gracefully");
});

test("addMonthlySpend: rounds to 4 decimal places (avoid floating-point drift in DB)", async () => {
  const db = makeMockDb({
    rows: [{ id: "c_inst", monthly_spend_usd: 0.1, monthly_spend_cap_usd: 50, monthly_spend_period_start: "2026-04-01" }],
  });
  const r = await addMonthlySpend({ DB: db }, "c_inst", 0.2, apr2026);
  // 0.1 + 0.2 in JS = 0.30000000000000004; we round to 4 places.
  assert.equal(r.newSpendUsd, 0.3);
});
