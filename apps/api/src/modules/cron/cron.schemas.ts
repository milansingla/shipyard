import { z } from "zod";

import { CronSyntaxError, parseCron } from "../../lib/cron.js";

export const MAX_CRON_JOBS_PER_PROJECT = 20;

/** Lowercase label, unique within the project. */
export const cronJobNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/, "must be 1–30 lowercase letters, digits or -, starting with a letter");

export const cronScheduleSchema = z
  .string()
  .trim()
  .max(100)
  .superRefine((schedule, ctx) => {
    try {
      parseCron(schedule);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof CronSyntaxError ? error.message : "invalid schedule" });
    }
  });

/** One line, run with `sh -c` in the service's image. */
export const cronCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(/^[^\n\r\0]+$/, "must be a single line");

export const cronTimeoutSchema = z.int().min(10).max(86_400);

export const createCronJobSchema = z.strictObject({
  name: cronJobNameSchema,
  serviceId: z.uuid(),
  schedule: cronScheduleSchema,
  command: cronCommandSchema,
  timeoutSeconds: cronTimeoutSchema.optional(),
  enabled: z.boolean().optional(),
});

export const updateCronJobSchema = z
  .strictObject({
    schedule: cronScheduleSchema.optional(),
    command: cronCommandSchema.optional(),
    timeoutSeconds: cronTimeoutSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Nothing to update.");

export type CreateCronJobInput = z.infer<typeof createCronJobSchema>;
export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;
