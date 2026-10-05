-- V3 deployment state machine.
-- Hand-written: Prisma would recreate the enum, which fails for existing rows
-- still holding 'PENDING'. Renaming keeps every row valid.
ALTER TYPE "DeploymentStatus" RENAME VALUE 'PENDING' TO 'QUEUED';
ALTER TYPE "DeploymentStatus" ADD VALUE 'DETECTING' AFTER 'CLONING';
ALTER TYPE "DeploymentStatus" ADD VALUE 'HEALTH_CHECKING' AFTER 'STARTING';
ALTER TYPE "DeploymentStatus" ADD VALUE 'ROUTING' AFTER 'HEALTHY';

ALTER TABLE "deployments" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

-- Which stage a FAILED deployment failed in (null for older rows).
ALTER TABLE "deployments" ADD COLUMN "failedStage" "DeploymentStatus";
