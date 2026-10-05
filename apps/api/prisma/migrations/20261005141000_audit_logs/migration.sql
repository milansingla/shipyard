-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PROJECT_CREATED', 'PROJECT_SETTINGS_CHANGED', 'PROJECT_DELETED', 'DEPLOYMENT_STARTED', 'DEPLOYMENT_SUCCEEDED', 'DEPLOYMENT_FAILED', 'ROLLBACK', 'ENV_VAR_SET', 'ENV_VAR_DELETED', 'DOMAIN_ADDED', 'DOMAIN_REMOVED', 'API_KEY_CREATED', 'API_KEY_REVOKED');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorId" UUID,
    "projectId" UUID,
    "projectName" TEXT,
    "ownerId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_projectId_id_idx" ON "audit_logs"("projectId", "id");

-- CreateIndex
CREATE INDEX "audit_logs_ownerId_id_idx" ON "audit_logs"("ownerId", "id");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_id_idx" ON "audit_logs"("actorId", "id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
