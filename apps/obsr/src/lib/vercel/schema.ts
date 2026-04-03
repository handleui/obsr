import { z } from "zod";

export const VercelTargetInputSchema = z.object({
  teamId: z.string().trim().min(1),
  teamSlug: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1),
  projectName: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
});

export const VercelConnectionInputSchema = z.object({
  accessToken: z.string().trim().min(1),
  targets: z.array(VercelTargetInputSchema).min(1),
});

export const VercelSyncRequestSchema = z.object({
  targetIds: z.array(z.string().trim().min(1)).max(50).optional(),
});

export const VercelTargetSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamSlug: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  repo: z.string().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastDeploymentCreatedAt: z.string().datetime().nullable(),
});

export const VercelConnectionResponseSchema = z.object({
  configured: z.literal(true),
  targets: z.array(VercelTargetSchema),
});

export const VercelSyncResponseSchema = z.object({
  targetsSynced: z.number().int().min(0),
  deploymentsSeen: z.number().int().min(0),
  observationsCreated: z.number().int().min(0),
  observationsSkipped: z.number().int().min(0),
  issueIds: z.array(z.string()),
});

export type VercelConnectionInput = z.infer<typeof VercelConnectionInputSchema>;
export type VercelTargetInput = z.infer<typeof VercelTargetInputSchema>;
export type VercelSyncRequest = z.infer<typeof VercelSyncRequestSchema>;
export type VercelTarget = z.infer<typeof VercelTargetSchema>;
export type VercelConnectionResponse = z.infer<
  typeof VercelConnectionResponseSchema
>;
export type VercelSyncResponse = z.infer<typeof VercelSyncResponseSchema>;
