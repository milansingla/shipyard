-- AlterEnum
ALTER TYPE "DeploymentEventType" ADD VALUE 'ROLLBACK';

-- AlterEnum
ALTER TYPE "DeploymentStatus" ADD VALUE 'ROLLING_BACK';

-- AlterTable
ALTER TABLE "deployment_events" ADD COLUMN     "relatedDeploymentId" UUID;
