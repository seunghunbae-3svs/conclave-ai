import {
  FileSystemMemoryStore,
  computeAllAgentScores,
  formatAnswerKeyForPrompt,
  formatFailureForPrompt,
} from "@conclave-ai/core";
import type { AnswerKey, EpisodicEntry, FailureEntry, MemoryStore } from "@conclave-ai/core";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";

const HELP = `conclave mcp-server — run an MCP server exposing conclave's memory (decision #11)

Usage:
  conclave mcp-server

Starts a stdio-transport MCP server that exposes read-only views of the
local memory substrate. Designed to be launched by an MCP client like
Claude Desktop, Cursor, or Windsurf. Example Claude Desktop config:

  {
    "mcpServers": {
      "conclave-ai": {
        "command": "conclave",
        "args": ["mcp-server"],
        "cwd": "/path/to/your-repo"
      }
    }
  }

Exposed tools (read-only — actual reviews still run via \`conclave review\`):
  - conclave_scores       — per-agent weighted performance (decision #19)
  - conclave_retrieve     — RAG over local answer-keys + failures
  - conclave_list_episodic — recent review events + outcomes
`;

export async function mcpServer(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const { config, configDir } = await loadConfig();
  const memoryRoot = resolveMemoryRoot(config, configDir);
  const store = new FileSystemMemoryStore({ root: memoryRoot });

  // Lazy-import the MCP SDK so users who never invoke this command
  // don't pay the load cost at CLI startup.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { z } = await import("zod");

  const server = new McpServer({
    name: "conclave-ai",
    version: "0.0.0",
  });

  server.registerTool(
    "conclave_scores",
    {
      title: "Per-agent performance scores",
      description:
        "Returns each agent's rolling weighted score from the local memory store (decision #19).",
      inputSchema: {},
    },
    async () => {
      const scores = await computeAllAgentScores(store);
      return {
        content: [{ type: "text", text: JSON.stringify(scores, null, 2) }],
      };
    },
  );

  server.registerTool(
    "conclave_retrieve",
    {
      title: "Retrieve answer-keys and failures",
      description:
        "BM25-style retrieval over the local memory substrate. Returns the top-K answer-keys (정답지) and failures (오답지) matching `query`.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query — typically a diff summary or blocker category"),
        k: z.number().int().positive().max(32).optional().describe("Max per bucket, default 8"),
        domain: z.enum(["code", "design"]).optional().describe("Filter by domain"),
        repo: z.string().optional().describe("Repo slug for repo-boost ranking"),
      },
    },
    async ({ query, k, domain, repo }) => {
      const retrieval = await retrieveReadOnly(store, { query, k, domain, repo });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                answerKeys: retrieval.answerKeys.map(formatAnswerKeyForPrompt),
                failures: retrieval.failures.map(formatFailureForPrompt),
                ruleCount: retrieval.rules.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "conclave_list_episodic",
    {
      title: "List recent episodic entries",
      description:
        "Returns recent review events. Useful for ops dashboards + closing the outcome loop.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe("Max rows, default 20"),
        outcomeFilter: z
          .enum(["merged", "rejected", "reworked", "pending"])
          .optional()
          .describe("Filter by outcome"),
      },
    },
    async ({ limit, outcomeFilter }) => {
      const rows = await listEpisodic(store, { limit, outcomeFilter });
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("conclave mcp-server: ready on stdio\n");
}

/**
 * Pure read-only wrapper around `store.retrieve` — exposed for unit
 * tests (tool handlers call this same function so we can exercise the
 * semantics without the MCP transport layer).
 */
export async function retrieveReadOnly(
  store: MemoryStore,
  opts: { query: string; k?: number; domain?: "code" | "design"; repo?: string },
): Promise<{ answerKeys: AnswerKey[]; failures: FailureEntry[]; rules: unknown[] }> {
  const query: Parameters<MemoryStore["retrieve"]>[0] = { query: opts.query };
  if (opts.k !== undefined) query.k = opts.k;
  if (opts.domain !== undefined) query.domain = opts.domain;
  if (opts.repo !== undefined) query.repo = opts.repo;
  return (await store.retrieve(query)) as { answerKeys: AnswerKey[]; failures: FailureEntry[]; rules: unknown[] };
}

export async function listEpisodic(
  store: MemoryStore,
  opts: { limit?: number; outcomeFilter?: EpisodicEntry["outcome"] },
): Promise<EpisodicEntry[]> {
  const limit = opts.limit ?? 20;
  const all = await store.listEpisodic();
  const filtered = opts.outcomeFilter
    ? all.filter((e) => e.outcome === opts.outcomeFilter)
    : all;
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return filtered.slice(0, limit);
}
