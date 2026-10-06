-- Alerts and the channels they are sent to.


-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('WEBHOOK', 'SLACK');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('DEPLOYMENT_FAILED', 'APP_DOWN', 'WORKER_OFFLINE', 'HIGH_CPU', 'HIGH_MEMORY', 'DISK_PRESSURE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "diskFreePercent" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "name" TEXT NOT NULL,
    "type" "NotificationChannelType" NOT NULL,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "projectId" UUID,
    "kind" "AlertKind" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_channels_organizationId_idx" ON "notification_channels"("organizationId");

-- CreateIndex
CREATE INDEX "alerts_organizationId_status_openedAt_idx" ON "alerts"("organizationId", "status", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "alerts_fingerprint_status_idx" ON "alerts"("fingerprint", "status");

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One open alert per fingerprint: a repeat of the same problem reuses it.
CREATE UNIQUE INDEX "alerts_one_open_per_fingerprint" ON "alerts"("fingerprint") WHERE "status" = 'OPEN';
