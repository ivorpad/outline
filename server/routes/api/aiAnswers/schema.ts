import { z } from "zod";
import { BaseSchema } from "../schema";

export const AiAnswersReindexSchema = BaseSchema.extend({
  body: z
    .object({
      force: z.boolean().optional(),
    })
    .optional(),
});

export type AiAnswersReindexReq = z.infer<typeof AiAnswersReindexSchema>;

export const AiAnswersAskSchema = BaseSchema.extend({
  body: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(20).optional(),
  }),
});

export type AiAnswersAskReq = z.infer<typeof AiAnswersAskSchema>;

export const AiAnswersSearchSchema = BaseSchema.extend({
  body: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(50).optional(),
  }),
});

export type AiAnswersSearchReq = z.infer<typeof AiAnswersSearchSchema>;

export const AiAnswersStatusSchema = BaseSchema.extend({
  body: z.object({}).optional(),
});

export type AiAnswersStatusReq = z.infer<typeof AiAnswersStatusSchema>;
