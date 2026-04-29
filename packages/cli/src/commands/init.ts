import { detectRepo, type DetectRepoDeps } from "./init/repo-detect.js";
import { writeConfig, CONFIG_FILENAME } from "./init/config-writer.js";
import {
  writeWorkflow,
  writeReworkWorkflow,
  writeMergeWorkflow,
  formatWorkflowStatusLine,
  WORKFLOW_PATH,
  REWORK_WORKFLOW_PATH,
  MERGE_WORKFLOW_PATH,
  REUSABLE_REF,
} from "./init/workflow-writer.js";
import { createPrompter, createNonInteractivePrompter, type Prompter } from "./init/prompts.js";
import { runOauthFlow, type OauthFlowDeps } from "./init/oauth-flow.js";
import { CentralClient, DEFAULT_CENTRAL_URL } from "./init/central-client.js";

/**
 * Default Telegram bot username for the central bot. Overridable via
 * `CONCLAVE_BOT_USERNAME` env var if Bae ends up using a different
 * handle after BotFather negotiations.
 */
const DEFAULT_BOT_USERNAME = process.env["CONCLAVE_BOT_USERNAME"] ?? "Conclave_ai_bot";

const HELP = `conclave init — set up conclave-ai on this repo (v0.4 wizard)

Usage:
  conclave init [--yes] [--reconfigure] [--skip-oauth] [--repo <owner/name>] [--central-url <url>]

Flags:
  --yes               non-interactive; use defaults, fail fast if required info is missing
  --reconfigure       overwrite existing .conclaverc.json and workflow file
  --skip-oauth        do not run GitHub device-flow OAuth (local-only install; no federated memory)
  --repo <slug>       use this repo slug instead of detecting via \`git remote\`
  --central-url <url> override the central plane URL (default: ${DEFAULT_CENTRAL_URL})
  --cwd <dir>         target directory (default: current)
  --help, -h          show this

What it does:
  1. Detects your GitHub repo (or takes --repo)
  2. Writes .conclaverc.json with the 2-tier council defaults
  3. Writes .github/workflows/conclave.yml — a 3-line wrapper pointing at
     ${REUSABLE_REF}
  4. Runs GitHub OAuth device flow against the central plane and installs
     CONCLAVE_TOKEN as a GitHub repo secret via \`gh secret set\`
  5. Prints the /link command for the central @${DEFAULT_BOT_USERNAME} Telegram bot
  6. Prints next-step instructions for API key secrets

Env vars:
  CONCLAVE_CENTRAL_URL   override the central plane URL
  CONCLAVE_BOT_USERNAME  override the Telegram bot handle
`;

export interface InitArgs {
  yes: boolean;
  reconfigure: boolean;
  repo?: string;
  cwd: string;
  /** Skip the OAuth step (central plane call). For testing + air-gapped users. */
  skipOauth: boolean;
  /** Override the central plane base URL. Default comes from env / constant. */
  centralUrl?: string;
  help: boolean;
}

export function parseArgv(argv: string[]): InitArgs {
  const out: InitArgs = { yes: false, reconfigure: false, cwd: ".", skipOauth: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--reconfigure") out.reconfigure = true;
    else if (a === "--skip-oauth") out.skipOauth = true;
    else if (a === "--repo" && argv[i + 1]) {
      out.repo = argv[i + 1];
      i += 1;
    } else if (a === "--central-url" && argv[i + 1]) {
      out.centralUrl = argv[i + 1];
      i += 1;
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = argv[i + 1]!;
      i += 1;
    }
  }
  return out;
}

export interface RunInitDeps {
  prompter?: Prompter;
  detectRepoDeps?: DetectRepoDeps;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Injected OAuth flow deps — tests replace the client + secret setter. */
  oauthDeps?: OauthFlowDeps;
}

export async function runInit(args: InitArgs, deps: RunInitDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const prompter =
    deps.prompter ?? (args.yes ? createNonInteractivePrompter(process.env) : createPrompter());

  try {
    // Step 1 — detect repo.
    let repoSlug = args.repo;
    if (!repoSlug) {
      try {
        const detected = await detectRepo({ ...deps.detectRepoDeps, cwd: args.cwd });
        repoSlug = detected.slug;
        stdout(`• repo: ${repoSlug}  (from git remote)\n`);
      } catch (err) {
        stderr(`${(err as Error).message}\n`);
        return 1;
      }
    } else {
      stdout(`• repo: ${repoSlug}  (--repo override)\n`);
    }

    // Step 2 — existing config handling surfaced to the user.
    if (!args.reconfigure) {
      stdout(`• mode:  initial (pass --reconfigure to overwrite existing files)\n`);
    } else {
      stdout(`• mode:  reconfigure — will overwrite .conclaverc.json + workflow file\n`);
    }

    // Step 3 — OAuth / CONCLAVE_TOKEN via central plane device flow.
    let oauthOutcome: "success" | "skipped" | "failed" = "skipped";
    let oauthToken: string | undefined;
    if (!args.skipOauth) {
      const oauthDeps: OauthFlowDeps = {
        stdout,
        stderr,
        ...(deps.oauthDeps ?? {}),
      };
      // If the caller didn't inject a client, build one honoring --central-url.
      if (!oauthDeps.client) {
        const opts: ConstructorParameters<typeof CentralClient>[0] = {};
        if (args.centralUrl) opts.baseUrl = args.centralUrl;
        oauthDeps.client = new CentralClient(opts);
      }
      stdout(
        `\n• GitHub OAuth against central plane: ${oauthDeps.client.baseUrl}\n` +
          `  (override with --central-url <url> or CONCLAVE_CENTRAL_URL env)\n`,
      );
      const exit = await runOauthFlow(repoSlug!, oauthDeps);
      if (exit.kind === "success") {
        oauthOutcome = "success";
        oauthToken = exit.token;
        if (exit.rotated) {
          stdout(`  (CONCLAVE_TOKEN rotated for an existing install)\n`);
        }
      } else if (exit.kind === "denied") {
        stderr(`  ✗ OAuth denied${exit.reason ? ": " + exit.reason : ""}. Continuing without central registration.\n`);
        oauthOutcome = "failed";
      } else if (exit.kind === "expired") {
        stderr(`  ✗ OAuth code expired before you authorized. Re-run \`conclave init\` to try again.\n`);
        oauthOutcome = "failed";
      } else {
        stderr(`  ✗ OAuth failed: ${exit.message}\n`);
        oauthOutcome = "failed";
      }
    } else {
      stdout(`\n• GitHub OAuth: skipped (--skip-oauth). Council runs locally; federated memory disabled.\n`);
    }

    // Step 4 — API keys. Prompt + print guidance; we do NOT write them to
    // GitHub secrets ourselves in v0.4-alpha (that needs the OAuth token
    // from step 3). Users currently set secrets via \`gh secret set\`.
    // Input is masked so keys don't end up in terminal scrollback.
    const anthropic = await prompter.askSecret(
      "ANTHROPIC_API_KEY (required, not stored — used only for a one-time gh secret set hint)",
      { required: false },
    );
    const openai = await prompter.askSecret("OPENAI_API_KEY (optional, press Enter to skip)", {
      required: false,
    });
    const gemini = await prompter.askSecret("GEMINI_API_KEY (optional, press Enter to skip)", {
      required: false,
    });
    const selectedAgents: string[] = [];
    if (anthropic) selectedAgents.push("claude");
    if (openai) selectedAgents.push("openai");
    if (gemini) selectedAgents.push("gemini");
    if (selectedAgents.length === 0) {
      stdout(
        `  (no API keys provided — config writes all three agents; set repo secrets before PRs trigger reviews)\n`,
      );
    }

    // Step 5 — Telegram central bot link hint. The CLI can't silently
    // pair the chat for you (chat ownership lives on the user's phone),
    // so we print the exact /link command instead. If OAuth failed, the
    // user has no CONCLAVE_TOKEN to link with — skip the hint.
    if (oauthOutcome === "success" && oauthToken) {
      stdout(
        `\n• Telegram link step:\n` +
          `  1. Open Telegram and DM @${DEFAULT_BOT_USERNAME}\n` +
          `  2. Send this command (copy + paste, token is shown only here):\n` +
          `       /link ${oauthToken}\n` +
          `  Bot confirms with "✅ Linked this chat to ${repoSlug}"\n`,
      );
    }

    // Step 6 — write config.
    const cfgResult = await writeConfig({
      cwd: args.cwd,
      repoSlug: repoSlug!,
      force: args.reconfigure,
      selectedAgents: selectedAgents.length > 0 ? selectedAgents : undefined,
    });
    if (cfgResult.skipped) {
      stdout(`• skip:  ${CONFIG_FILENAME} exists (pass --reconfigure to overwrite)\n`);
    } else {
      stdout(`• wrote: ${cfgResult.path}\n`);
    }

    // Step 7 — write wrapper workflow.
    // v0.13.18 — output rendering uses the new 4-state status so the
    // user can tell apart "skip because nothing to do" vs "skip
    // because we found a customised file we won't touch" vs
    // "auto-migrated a stale managed file" vs "fresh write".
    const wfResult = await writeWorkflow({ cwd: args.cwd, force: args.reconfigure });
    stdout(formatWorkflowStatusLine(WORKFLOW_PATH, wfResult.status));

    // Step 7b — v0.10: write the consumer-side rework dispatcher so
    // central-plane's `conclave-rework` repository_dispatch actually
    // has a listener. Without this file the autonomous loop never
    // closes for new installs (review fires, dispatch fires, nothing
    // listens).
    const reworkResult = await writeReworkWorkflow({
      cwd: args.cwd,
      force: args.reconfigure,
    });
    stdout(formatWorkflowStatusLine(REWORK_WORKFLOW_PATH, reworkResult.status));

    // Step 7c — v0.13.17: write the consumer-side merge dispatcher so
    // central-plane's `conclave-merge` repository_dispatch (fired
    // when the user clicks ✅ Merge & Push in Telegram) actually has
    // a listener. Without this file the dispatch lands but no
    // workflow runs; the user-visible loop feels broken even though
    // everything upstream worked.
    const mergeResult = await writeMergeWorkflow({
      cwd: args.cwd,
      force: args.reconfigure,
    });
    stdout(formatWorkflowStatusLine(MERGE_WORKFLOW_PATH, mergeResult.status));

    // Step 8 — next steps.
    const needsApiKeySetup = Boolean(anthropic || openai || gemini);
    stdout(
      `\n✔ conclave init complete.\n\n` +
        (needsApiKeySetup
          ? `Next steps:\n` +
            (anthropic
              ? `  • Install Anthropic key:\n       gh secret set ANTHROPIC_API_KEY --repo ${repoSlug} --body "$ANTHROPIC_API_KEY"\n`
              : "") +
            (openai
              ? `  • Install OpenAI key:\n       gh secret set OPENAI_API_KEY --repo ${repoSlug} --body "$OPENAI_API_KEY"\n`
              : "") +
            (gemini
              ? `  • Install Gemini key:\n       gh secret set GEMINI_API_KEY --repo ${repoSlug} --body "$GEMINI_API_KEY"\n`
              : "")
          : `Next steps:\n  • Set at least one LLM API key secret on ${repoSlug} before opening a PR (ANTHROPIC_API_KEY required).\n`) +
        `  • Register a PAT for the autonomy rework loop (REQUIRED for autofix → next-cycle review chain to fire):\n` +
        `       1. Create a token at https://github.com/settings/tokens/new with \`repo\` + \`workflow\` scopes\n` +
        `       2. gh secret set ORCHESTRATOR_PAT --repo ${repoSlug} --body "ghp_..."\n` +
        `       (Skip if you only run one-shot \`conclave review\` without auto-rework. \`conclave doctor\` will warn if missing.)\n` +
        `  • Commit:\n` +
        `       git add ${CONFIG_FILENAME} ${WORKFLOW_PATH} ${REWORK_WORKFLOW_PATH} ${MERGE_WORKFLOW_PATH}\n` +
        `       git commit -m "chore: install conclave-ai review"\n` +
        `  • Open a PR — the council will comment with a verdict, and Telegram notifications arrive` +
        (oauthOutcome === "success" ? ` in the chat you /link'd.\n` : `. (OAuth skipped — Telegram notifications disabled.)\n`),
    );
    return 0;
  } finally {
    prompter.close();
  }
}

export async function init(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const code = await runInit(args);
  if (code !== 0) process.exit(code);
}
