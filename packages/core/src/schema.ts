import { z } from "zod";

export const SeveritySchema = z.enum(["blocker", "major", "minor", "nit"]);

export const BlockerSchema = z.object({
  severity: SeveritySchema,
  category: z.string().min(1),
  message: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});

export const ReviewResultSchema = z.object({
  agent: z.string().min(1),
  verdict: z.enum(["approve", "rework", "reject"]),
  blockers: z.array(BlockerSchema),
  summary: z.string(),
  tokensUsed: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

export type BlockerInput = z.input<typeof BlockerSchema>;
export type ReviewResultInput = z.input<typeof ReviewResultSchema>;
