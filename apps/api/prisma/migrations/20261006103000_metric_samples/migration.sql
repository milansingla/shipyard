-- Resource samples of running deployments (24 h).


-- CreateTable
CREATE TABLE "metric_samples" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryMb" DOUBLE PRECISION NOT NULL,
    "memoryLimitMb" DOUBLE PRECISION,
    "restartCount" INTEGER NOT NULL,
    "running" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_samples_projectId_at_idx" ON "metric_samples"("projectId", "at");

-- CreateIndex
CREATE INDEX "metric_samples_deploymentId_at_idx" ON "metric_samples"("deploymentId", "at");

-- CreateIndex
CREATE INDEX "metric_samples_at_idx" ON "metric_samples"("at");

