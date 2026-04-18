export type Severity = "blocker" | "major" | "minor" | "nit";

export interface Blocker {
  severity: Severity;
  category: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ReviewContext {
  diff: string;
  repo: string;
  pullNumber: number;
  prevSha?: string;
  newSha: string;
  answerKeys?: string[];
  failureCatalog?: string[];
}

export interface ReviewResult {
  agent: string;
  verdict: "approve" | "rework" | "reject";
  blockers: Blocker[];
  summary: string;
  tokensUsed?: number;
  costUsd?: number;
}

export interface Agent {
  readonly id: string;
  readonly displayName: string;
  review(ctx: ReviewContext): Promise<ReviewResult>;
}
