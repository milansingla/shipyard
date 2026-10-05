-- Persistent volumes per service (Restrict: rows are never dropped by a cascade).
-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'VOLUME_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'VOLUME_DELETED';
-- CreateTable
CREATE TABLE "volumes" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "dockerName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "volumes_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "volumes_dockerName_key" ON "volumes"("dockerName");
-- CreateIndex
CREATE UNIQUE INDEX "volumes_serviceId_name_key" ON "volumes"("serviceId", "name");
-- CreateIndex
CREATE UNIQUE INDEX "volumes_serviceId_mountPath_key" ON "volumes"("serviceId", "mountPath");
-- AddForeignKey
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
