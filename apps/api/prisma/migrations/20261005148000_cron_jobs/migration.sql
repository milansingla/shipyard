-- Cron jobs: commands run on a schedule in short-lived containers, with every run recorded.

-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CronRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- AlterEnum


ALTER TYPE "AuditAction" ADD VALUE 'CRON_JOB_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CRON_JOB_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'CRON_JOB_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'CRON_JOB_RUN';

-- CreateTable
CREATE TABLE "cron_jobs" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 3600,
    "nextRunAt" TIMESTAMP(3),
    "managedBy" "ServiceSource" NOT NULL DEFAULT 'DASHBOARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_runs" (
    "id" UUID NOT NULL,
    "cronJobId" UUID NOT NULL,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" "CronRunTrigger" NOT NULL DEFAULT 'SCHEDULE',
    "deploymentId" UUID,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "output" TEXT NOT NULL DEFAULT '',
    "errorMessage" TEXT,
    "containerName" TEXT,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_jobs_enabled_nextRunAt_idx" ON "cron_jobs"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "cron_jobs_projectId_name_key" ON "cron_jobs"("projectId", "name");

-- CreateIndex
CREATE INDEX "cron_runs_cronJobId_startedAt_idx" ON "cron_runs"("cronJobId", "startedAt");

-- AddForeignKey
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_cronJobId_fkey" FOREIGN KEY ("cronJobId") REFERENCES "cron_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A run timeout between 10 seconds and 24 hours.
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_timeout_range" CHECK ("timeoutSeconds" BETWEEN 10 AND 86400);
