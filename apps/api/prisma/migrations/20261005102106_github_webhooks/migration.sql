-- CreateEnum
CREATE TYPE "DeploymentTrigger" AS ENUM ('MANUAL', 'PUSH');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "trigger" "DeploymentTrigger" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "outcome" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_receivedAt_idx" ON "webhook_deliveries"("receivedAt");
