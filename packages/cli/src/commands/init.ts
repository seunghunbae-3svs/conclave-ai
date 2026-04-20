import { detectRepo, type DetectRepoDeps } from "./init/repo-detect.js";
import { writeConfig, CONFIG_FILENAME } from "./init/config-writer.js";
import { writeWorkflow, WORKFLOW_PATH, REUSABLE_REF } from "./init/workflow-writer.js";
import { createPrompter, createNonInteractivePrompter, type Prompter } from "./init/prompts.js";

const HELP = `conclave init — set up conclave-ai on this repo (v0.4 wizard)

Usage:
  conclave init [--yes] [--reconfigure] [--repo <owner/name>]

Flags:
  --yes               non-interactive; use defaults, fail fast if required info is missing
  --reconfigure       overwrite existing .conclaverc.json and workflow file
  --repo <slug>       use this repo slug instead of detecting via \`git remote\`
  --cwd <dir>         target directory (default: current)
  --help, -h          show this

What it does:
  1. Detects your GitHub repo (or takes --repo)
  2. Writes .conclaverc.json with the 2-tier council defaults
  3. Writes .github/workflows/conclave.yml — a 3-line wrapper pointing at
     ${REUSABLE_REF}
  4. Prints next-step instructions (API key secrets + Telegram /link)

What it does NOT do yet (deferred to the central-plane PR):
  - Mint a CONCLAVE_TOKEN via GitHub OAuth
  - Link your Telegram chat to the central @conclave_ai bot
  Both steps print "TODO" placeholders with guidance for now.
`;

export interface InitArgs {
  yes: boolean;
  reconfigure: boolean;
  repo?: string;
  cwd: string;
  help: boolean;
}

export function parseArgv(argv: string[]): InitArgs {
  const out: InitArgs = { yes: false, reconfigure: false, cwd: ".", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--reconfigure") out.reconfigure = true;
    else if (a === "--repo" && argv[i + 1]) {
      out.repo = argv[i + 1];
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

    // Step 3 — OAuth / CONCLAVE_TOKEN. STUB (central service lands in follow-up PR).
    stdout(
      `\n• GitHub OAuth + CONCLAVE_TOKEN: [TODO — ships with central plane Worker in v0.4.0-beta]\n` +
        `  For now: no central registration. Council runs locally using your own API keys.\n`,
    );

    // Step 4 — API keys. Prompt + print guidance; we do NOT write them to
    // GitHub secrets ourselves in v0.4-alpha (that needs the OAuth token
    // from step 3). Users currently set secrets via \`gh secret set\`.
    const anthropic = await prompter.ask(
      "ANTHROPIC_API_KEY (required, not stored — used only for a one-time gh secret set hint)",
      { required: false },
    );
    const openai = await prompter.ask("OPENAI_API_KEY (optional, press Enter to skip)", {
      required: false,
    });
    const gemini = await prompter.ask("GEMINI_API_KEY (optional, press Enter to skip)", {
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

    // Step 5 — Telegram central bot link. STUB.
    stdout(
      `\n• Telegram @conclave_ai link: [TODO — ships with central plane Worker]\n` +
        `  For now: skipping Telegram. The reusable workflow handles its absence gracefully.\n`,
    );

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
    const wfResult = await writeWorkflow({ cwd: args.cwd, force: args.reconfigure });
    if (wfResult.skipped) {
      stdout(`• skip:  ${WORKFLOW_PATH} exists (pass --reconfigure to overwrite)\n`);
    } else {
      stdout(`• wrote: ${wfResult.path}\n`);
    }

    // Step 8 — next steps.
    stdout(
      `\n✔ conclave init complete.\n\n` +
        `Next steps:\n` +
        `  1. Set repo secrets:\n` +
        `       gh secret set ANTHROPIC_API_KEY --repo ${repoSlug} --body "$ANTHROPIC_API_KEY"\n` +
        (openai ? `       gh secret set OPENAI_API_KEY   --repo ${repoSlug} --body "$OPENAI_API_KEY"\n` : "") +
        (gemini ? `       gh secret set GEMINI_API_KEY   --repo ${repoSlug} --body "$GEMINI_API_KEY"\n` : "") +
        `  2. Commit:\n` +
        `       git add ${CONFIG_FILENAME} ${WORKFLOW_PATH}\n` +
        `       git commit -m "chore: install conclave-ai review"\n` +
        `  3. Open a PR to test — council will comment with a verdict.\n` +
        `\nv0.4.0-beta (central registration + Telegram linking) ships soon — no action needed then, this install auto-upgrades via the reusable workflow.\n`,
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
