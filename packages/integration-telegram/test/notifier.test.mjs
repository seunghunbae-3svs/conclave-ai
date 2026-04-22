import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramNotifier, DEFAULT_CENTRAL_URL } from "../dist/index.js";

// ---- mock fetches --------------------------------------------------------

function mockFetch(response = { ok: true, result: { message_id: 1 } }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  fn.calls = calls;
  return fn;
}

function mockCentralFetch(response = { ok: true, delivered: 1 }, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  fn.calls = calls;
  return fn;
}

const baseInput = {
  outcome: {
    verdict: "approve",
    rounds: 1,
    consensusReached: true,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
  },
  ctx: { diff: "", repo: "acme/app", pullNumber: 42, newSha: "abc" },
  episodicId: "ep-test",
  totalCostUsd: 0.01,
};

const reworkInput = {
  outcome: {
    verdict: "rework",
    rounds: 1,
    consensusReached: false,
    results: [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [
          { severity: "major", category: "security", message: "hardcoded secret", file: "a.ts", line: 5 },
        ],
        summary: "needs fixes",
      },
    ],
  },
  ctx: { diff: "", repo: "acme/app", pullNumber: 7, newSha: "def" },
  episodicId: "ep-rework",
  totalCostUsd: 0.02,
};

function withEnv(mutations, fn) {
  const originals = {};
  for (const [k, v] of Object.entries(mutations)) {
    originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withEnvAsync(mutations, fn) {
  const originals = {};
  for (const [k, v] of Object.entries(mutations)) {
    originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---- direct path (path B) — legacy v0.3 behaviour, preserved ------------

test("TelegramNotifier direct: constructor throws on missing token when CONCLAVE_TOKEN absent", () => {
  withEnv(
    { TELEGRAM_BOT_TOKEN: undefined, CONCLAVE_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined },
    () => {
      assert.throws(() => new TelegramNotifier({ chatId: 1 }));
    },
  );
});

test("TelegramNotifier direct: constructor throws on missing chatId when CONCLAVE_TOKEN absent", () => {
  withEnv({ CONCLAVE_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, () => {
    assert.throws(() => new TelegramNotifier({ token: "t" }));
  });
});

test("TelegramNotifier direct: numeric-string chat id is coerced to number", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: undefined }, async () => {
    const f = mockFetch();
    const n = new TelegramNotifier({ token: "t", chatId: "-100123", fetch: f });
    await n.notifyReview(baseInput);
    assert.equal(typeof f.calls[0].body.chat_id, "number");
    assert.equal(f.calls[0].body.chat_id, -100123);
  });
});

test("TelegramNotifier direct: notifyReview posts HTML + disable_web_page_preview", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: undefined }, async () => {
    const f = mockFetch();
    const n = new TelegramNotifier({ token: "t", chatId: 999, fetch: f });
    await n.notifyReview(baseInput);
    assert.equal(f.calls[0].body.parse_mode, "HTML");
    assert.equal(f.calls[0].body.disable_web_page_preview, true);
    assert.match(f.calls[0].body.text, /Approved/);
  });
});

test("TelegramNotifier direct: includes inline action keyboard by default", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: undefined }, async () => {
    const f = mockFetch();
    const n = new TelegramNotifier({ token: "t", chatId: 999, fetch: f });
    await n.notifyReview(baseInput);
    const kb = f.calls[0].body.reply_markup?.inline_keyboard;
    assert.ok(Array.isArray(kb));
    assert.equal(kb[0].length, 3);
    const callbacks = kb[0].map((b) => b.callback_data);
    assert.ok(callbacks[0].startsWith("ep:ep-test:merged"));
    assert.ok(callbacks[1].startsWith("ep:ep-test:reworked"));
    assert.ok(callbacks[2].startsWith("ep:ep-test:rejected"));
  });
});

test("TelegramNotifier direct: includeActionButtons:false omits reply_markup", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: undefined }, async () => {
    const f = mockFetch();
    const n = new TelegramNotifier({
      token: "t",
      chatId: 999,
      fetch: f,
      includeActionButtons: false,
    });
    await n.notifyReview(baseInput);
    assert.equal(f.calls[0].body.reply_markup, undefined);
  });
});

test("TelegramNotifier direct: uses TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env fallback", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: undefined, TELEGRAM_BOT_TOKEN: "env-token", TELEGRAM_CHAT_ID: "555" },
    async () => {
      const f = mockFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      assert.ok(f.calls[0].url.includes("env-token"));
      assert.equal(f.calls[0].body.chat_id, 555);
    },
  );
});

test("TelegramNotifier direct: conforms to Notifier interface", () => {
  withEnv({ CONCLAVE_TOKEN: undefined }, () => {
    const n = new TelegramNotifier({
      token: "t",
      chatId: 1,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: {} }),
        text: async () => "",
      }),
    });
    assert.equal(n.id, "telegram");
    assert.equal(n.displayName, "Telegram");
    assert.equal(typeof n.notifyReview, "function");
  });
});

test("TelegramNotifier direct: logs 'via direct bot token'", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: undefined }, async () => {
    const f = mockFetch();
    const logs = [];
    const n = new TelegramNotifier({
      token: "t",
      chatId: 1,
      fetch: f,
      log: (m) => logs.push(m),
    });
    await n.notifyReview(baseInput);
    assert.ok(
      logs.some((l) => l.includes("via direct bot token")),
      `expected direct-path log, got: ${logs.join(" | ")}`,
    );
  });
});

// ---- central plane path (path A) — v0.4.4+ default ---------------------

test("TelegramNotifier central: CONCLAVE_TOKEN set → hits /review/notify instead of Bot API", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "c_tok_central", CONCLAVE_CENTRAL_URL: undefined },
    async () => {
      const f = mockCentralFetch({ ok: true, delivered: 1 });
      // No token/chatId opts — the central path doesn't require them.
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].url, `${DEFAULT_CENTRAL_URL}/review/notify`);
      assert.equal(f.calls[0].init.method, "POST");
      assert.equal(
        f.calls[0].init.headers.authorization,
        "Bearer c_tok_central",
      );
      const body = f.calls[0].body;
      assert.equal(body.repo_slug, "acme/app");
      assert.equal(body.pr_number, 42);
      assert.equal(body.verdict, "approve");
      assert.equal(body.episodic_id, "ep-test");
      assert.match(body.message, /Approved/);
    },
  );
});

test("TelegramNotifier central: honours CONCLAVE_CENTRAL_URL override", async () => {
  await withEnvAsync(
    {
      CONCLAVE_TOKEN: "c_tok_central",
      CONCLAVE_CENTRAL_URL: "https://staging.example.com",
    },
    async () => {
      const f = mockCentralFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      assert.equal(f.calls[0].url, "https://staging.example.com/review/notify");
    },
  );
});

test("TelegramNotifier central: strips trailing slash on central URL", async () => {
  await withEnvAsync(
    {
      CONCLAVE_TOKEN: "c_tok_central",
      CONCLAVE_CENTRAL_URL: "https://example.com/",
    },
    async () => {
      const f = mockCentralFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      assert.equal(f.calls[0].url, "https://example.com/review/notify");
    },
  );
});

test("TelegramNotifier central: includeActionButtons:false omits episodic_id in body", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_central" }, async () => {
    const f = mockCentralFetch();
    const n = new TelegramNotifier({ fetch: f, includeActionButtons: false });
    await n.notifyReview(baseInput);
    assert.equal(f.calls[0].body.episodic_id, undefined);
  });
});

test("TelegramNotifier central: includeActionButtons:true includes episodic_id", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_central" }, async () => {
    const f = mockCentralFetch();
    const n = new TelegramNotifier({ fetch: f, includeActionButtons: true });
    await n.notifyReview(reworkInput);
    assert.equal(f.calls[0].body.episodic_id, "ep-rework");
    assert.equal(f.calls[0].body.verdict, "rework");
  });
});

test("TelegramNotifier central: auto-selects central path when CONCLAVE_TOKEN is set and no bot token provided", async () => {
  await withEnvAsync(
    {
      CONCLAVE_TOKEN: "c_tok_central",
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    },
    async () => {
      const f = mockCentralFetch();
      // Nothing else passed — should still succeed via the central path.
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      assert.equal(f.calls[0].url, `${DEFAULT_CENTRAL_URL}/review/notify`);
    },
  );
});

test("TelegramNotifier central: 401 from central → notifyReview throws with informative message", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_central" }, async () => {
    const f = mockCentralFetch({ error: "unknown or revoked token" }, 401);
    const n = new TelegramNotifier({ fetch: f });
    await assert.rejects(n.notifyReview(baseInput), /HTTP 401/);
  });
});

test("TelegramNotifier central: logs 'via central plane'", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_central" }, async () => {
    const f = mockCentralFetch();
    const logs = [];
    const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
    await n.notifyReview(baseInput);
    assert.ok(
      logs.some((l) => l.includes("via central plane")),
      `expected central-plane log, got: ${logs.join(" | ")}`,
    );
  });
});

test("TelegramNotifier central: explicit useCentralPlane:false forces direct path even with CONCLAVE_TOKEN", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_central" }, async () => {
    const f = mockFetch();
    const n = new TelegramNotifier({
      token: "t",
      chatId: 1,
      fetch: f,
      useCentralPlane: false,
    });
    await n.notifyReview(baseInput);
    // Went to api.telegram.org, not /review/notify
    assert.ok(f.calls[0].url.includes("api.telegram.org"));
  });
});

test("TelegramNotifier central: useCentralPlane:true without CONCLAVE_TOKEN throws", () => {
  withEnv({ CONCLAVE_TOKEN: undefined }, () => {
    assert.throws(() => new TelegramNotifier({ useCentralPlane: true }));
  });
});

test("TelegramNotifier central: repo_slug falls back from GITHUB_REPOSITORY when ctx.repo absent", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "c_tok_central", GITHUB_REPOSITORY: "owner/fallback" },
    async () => {
      const f = mockCentralFetch();
      const n = new TelegramNotifier({ fetch: f });
      const input = {
        ...baseInput,
        ctx: { ...baseInput.ctx, repo: "" },
      };
      await n.notifyReview(input);
      assert.equal(f.calls[0].body.repo_slug, "owner/fallback");
    },
  );
});

// ---- plain summary (v0.6.1) --------------------------------------------

test("TelegramNotifier central: forwards plain_summary in request body when present", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_ps" }, async () => {
    const f = mockCentralFetch();
    const n = new TelegramNotifier({ fetch: f });
    const plainSummary = {
      whatChanged: "Plain what.",
      verdictInPlain: "Plain verdict.",
      nextAction: "Plain next.",
      raw: "...",
      locale: "en",
    };
    await n.notifyReview({ ...baseInput, plainSummary });
    const body = f.calls[0].body;
    assert.deepEqual(body.plain_summary, {
      whatChanged: "Plain what.",
      verdictInPlain: "Plain verdict.",
      nextAction: "Plain next.",
      locale: "en",
    });
    // message body should be the plain-summary rendering, not the tech one.
    assert.ok(body.message.includes("Plain what."));
    assert.ok(!/\[BLOCKER\]|\[MAJOR\]/i.test(body.message));
  });
});

test("TelegramNotifier central: omits plain_summary when not provided", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_ps2" }, async () => {
    const f = mockCentralFetch();
    const n = new TelegramNotifier({ fetch: f });
    await n.notifyReview(baseInput);
    const body = f.calls[0].body;
    assert.equal(body.plain_summary, undefined);
  });
});
// ---- v0.6.3 hardening: whitespace + blank CONCLAVE_TOKEN handling -------

test("TelegramNotifier path-selection: empty-string CONCLAVE_TOKEN falls back to direct path", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "", TELEGRAM_BOT_TOKEN: "env-token", TELEGRAM_CHAT_ID: "123" },
    async () => {
      const f = mockFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      // Empty CONCLAVE_TOKEN must not pick the central path; we should
      // see a Bot API call, not /review/notify.
      assert.ok(f.calls[0].url.includes("api.telegram.org"));
      assert.equal(f.calls[0].body.chat_id, 123);
    },
  );
});

test("TelegramNotifier path-selection: whitespace-only CONCLAVE_TOKEN falls back to direct path", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "   \n\t ", TELEGRAM_BOT_TOKEN: "env-token", TELEGRAM_CHAT_ID: "456" },
    async () => {
      const f = mockFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      // Whitespace-only should also miss the central path — otherwise we
      // would ship blank bearer tokens and fail auth at the central plane.
      assert.ok(f.calls[0].url.includes("api.telegram.org"));
    },
  );
});

test("TelegramNotifier path-selection: trims CONCLAVE_TOKEN before sending on central path", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "  c_tok_central  \n" }, async () => {
    const f = mockCentralFetch();
    const n = new TelegramNotifier({ fetch: f });
    await n.notifyReview(baseInput);
    // Sent bearer must be the trimmed value, not the raw env reading.
    assert.equal(
      f.calls[0].init.headers.authorization,
      "Bearer c_tok_central",
    );
  });
});

test("TelegramNotifier central: diagnostic log reports CONCLAVE_TOKEN length without leaking value", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_1234567890" }, async () => {
    const f = mockCentralFetch();
    const logs = [];
    const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
    await n.notifyReview(baseInput);
    const diagnostic = logs.find((l) => l.includes("CONCLAVE_TOKEN is set"));
    assert.ok(diagnostic, `expected diagnostic log, got: ${logs.join(" | ")}`);
    // Must report length and must NOT include the token value itself.
    assert.match(diagnostic, /length: 16/);
    assert.ok(!diagnostic.includes("c_tok_1234567890"));
    assert.ok(diagnostic.includes("attempting central plane path"));
  });
});

test("TelegramNotifier central: no diagnostic log emitted when falling back to direct path", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "9" },
    async () => {
      const f = mockFetch();
      const logs = [];
      const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
      await n.notifyReview(baseInput);
      // The central-path diagnostic should only fire when we actually
      // take the central path.
      assert.ok(!logs.some((l) => l.includes("CONCLAVE_TOKEN is set")));
    },
  );
});

// ---- v0.7.5 Bug B: empty-string CONCLAVE_CENTRAL_URL must not corrupt path decision ----
//
// GitHub Actions workflows render `${{ vars.CONCLAVE_CENTRAL_URL || '' }}`
// as an EMPTY STRING env when the repo variable isn't set. The old code
// used `??` to fall back to DEFAULT_CENTRAL_URL — but `??` does NOT
// coalesce empty strings, so centralUrl became "". The constructor
// still logged "attempting central plane path" (misleading), and then
// `notifyReview` found `this.centralUrl` falsy, flipped to the direct
// path, and threw "direct path selected but client/chatId not configured"
// because the direct-branch fields were never populated.

test("v0.7.5 Bug B: empty-string CONCLAVE_CENTRAL_URL falls back to DEFAULT_CENTRAL_URL (not '')", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "c_tok_bugb", CONCLAVE_CENTRAL_URL: "" },
    async () => {
      const f = mockCentralFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      // Must hit the default central URL, not "/review/notify" against
      // an empty host.
      assert.equal(f.calls[0].url, `${DEFAULT_CENTRAL_URL}/review/notify`);
    },
  );
});

test("v0.7.5 Bug B: whitespace-only CONCLAVE_CENTRAL_URL also falls back to default", async () => {
  await withEnvAsync(
    { CONCLAVE_TOKEN: "c_tok_bugb2", CONCLAVE_CENTRAL_URL: "   \n\t " },
    async () => {
      const f = mockCentralFetch();
      const n = new TelegramNotifier({ fetch: f });
      await n.notifyReview(baseInput);
      assert.equal(f.calls[0].url, `${DEFAULT_CENTRAL_URL}/review/notify`);
    },
  );
});

test("v0.7.5 Bug B: empty-string CONCLAVE_CENTRAL_URL with CONCLAVE_TOKEN set — no 'direct path selected' crash", async () => {
  // This is the exact CI failure mode reported in Bug B.
  await withEnvAsync(
    {
      CONCLAVE_TOKEN: "c_tok_bugb_regression",
      CONCLAVE_CENTRAL_URL: "",
      // Note: TELEGRAM_BOT_TOKEN / CHAT_ID intentionally NOT set — if
      // the path flipped to direct, constructor would succeed (pre-fix)
      // but notifyReview would throw with the tell-tale message.
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    },
    async () => {
      const f = mockCentralFetch();
      const logs = [];
      const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
      // Must not throw "direct path selected but client/chatId not configured"
      await n.notifyReview(baseInput);
      // Must have taken the central path (empty-URL env normalised to default)
      assert.ok(
        logs.some((l) => l.includes("via central plane")),
        `expected 'via central plane' log, got: ${logs.join(" | ")}`,
      );
      assert.ok(
        !logs.some((l) => l.includes("via direct bot token")),
        `must NOT take direct path, got: ${logs.join(" | ")}`,
      );
      assert.equal(f.calls[0].url, `${DEFAULT_CENTRAL_URL}/review/notify`);
    },
  );
});

test("v0.7.5 Bug B: diagnostic log now includes central URL for operator visibility", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_url_log" }, async () => {
    const f = mockCentralFetch();
    const logs = [];
    const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
    await n.notifyReview(baseInput);
    const init = logs.find((l) => l.includes("attempting central plane path"));
    assert.ok(init, `expected init log, got: ${logs.join(" | ")}`);
    assert.ok(
      init.includes(DEFAULT_CENTRAL_URL),
      `init log must include central URL for diagnosis, got: ${init}`,
    );
  });
});

test("v0.7.5 Bug B: central plane delivered=0 emits 'not linked' hint to logs", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_d0" }, async () => {
    const f = mockCentralFetch({ ok: true, delivered: 0, reason: "no_linked_chat" });
    const logs = [];
    const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
    await n.notifyReview(baseInput);
    const diag = logs.find((l) => l.includes("delivered=0"));
    assert.ok(diag, `expected delivered=0 hint, got: ${logs.join(" | ")}`);
    assert.ok(diag.includes("no_linked_chat"));
    assert.ok(diag.includes("/link"));
  });
});

test("v0.7.5 Bug B: central plane delivered>0 logs success count without hint", async () => {
  await withEnvAsync({ CONCLAVE_TOKEN: "c_tok_d1" }, async () => {
    const f = mockCentralFetch({ ok: true, delivered: 3 });
    const logs = [];
    const n = new TelegramNotifier({ fetch: f, log: (m) => logs.push(m) });
    await n.notifyReview(baseInput);
    assert.ok(
      logs.some((l) => l.includes("delivered to 3 chat")),
      `expected delivered count log, got: ${logs.join(" | ")}`,
    );
  });
});
