-- The durable deploy queue: deploy requests wait here for a worker, which claims them with a lease.


-- CreateEnum
CREATE TYPE "DeployJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "workerId" UUID;

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "acceptsJobs" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "deploy_jobs" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "environmentId" UUID,
    "lockKey" TEXT NOT NULL,
    "deploymentIds" UUID[],
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trigger" "DeploymentTrigger" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "DeployJobStatus" NOT NULL DEFAULT 'QUEUED',
    "workerId" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryOfId" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "deploy_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deploy_jobs_status_priority_createdAt_idx" ON "deploy_jobs"("status", "priority" DESC, "createdAt");

-- CreateIndex
CREATE INDEX "deploy_jobs_lockKey_status_idx" ON "deploy_jobs"("lockKey", "status");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_jobs" ADD CONSTRAINT "deploy_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_jobs" ADD CONSTRAINT "deploy_jobs_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_jobs" ADD CONSTRAINT "deploy_jobs_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one job runs per project environment, whichever worker or process claims it.
CREATE UNIQUE INDEX "deploy_jobs_one_running_per_key" ON "deploy_jobs"("lockKey") WHERE "status" = 'RUNNING';

-- The built-in worker runs jobs.
UPDATE "workers" SET "acceptsJobs" = true WHERE "builtIn";
