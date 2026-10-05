-- CreateEnum
CREATE TYPE "DeploymentEventType" AS ENUM ('CREATED', 'STATUS_CHANGED');

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" SERIAL NOT NULL,
    "deploymentId" UUID NOT NULL,
    "type" "DeploymentEventType" NOT NULL,
    "fromStatus" "DeploymentStatus",
    "toStatus" "DeploymentStatus",
    "actorId" UUID,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deployment_events_deploymentId_id_idx" ON "deployment_events"("deploymentId", "id");

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
