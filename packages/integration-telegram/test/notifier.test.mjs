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
