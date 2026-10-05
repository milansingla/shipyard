-- Multi-service projects. Hand-written so nothing is lost: every existing
-- project gets a "web" service (the root of its repository, public) and all
-- of its deployments become that service's deployments.

CREATE TYPE "ServiceType" AS ENUM ('WEB', 'WORKER');

CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ServiceType" NOT NULL DEFAULT 'WEB',
    "sourceDir" TEXT NOT NULL DEFAULT '.',
    "buildCommand" TEXT,
    "startCommand" TEXT,
    "port" INTEGER,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "healthCheckPath" TEXT,
    "healthCheckPort" INTEGER,
    "healthCheckTimeoutSeconds" INTEGER,
    "cpuLimit" DOUBLE PRECISION,
    "memoryLimitMb" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "services_projectId_name_key" ON "services"("projectId", "name");
ALTER TABLE "services" ADD CONSTRAINT "services_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1. One "web" service per existing project.
INSERT INTO "services" ("id", "projectId", "name", "updatedAt")
  SELECT gen_random_uuid(), "id", 'web', now() FROM "projects";

-- 2. Existing deployments belong to it.
ALTER TABLE "deployments" ADD COLUMN "serviceId" UUID;
UPDATE "deployments" d SET "serviceId" = s."id" FROM "services" s WHERE s."projectId" = d."projectId" AND s."name" = 'web';
ALTER TABLE "deployments" ALTER COLUMN "serviceId" SET NOT NULL;
CREATE INDEX "deployments_serviceId_createdAt_idx" ON "deployments"("serviceId", "createdAt" DESC);
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Variables can be scoped to one service; existing ones apply to all.
ALTER TABLE "environment_variables" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'project';
DROP INDEX "environment_variables_projectId_key_key";
CREATE UNIQUE INDEX "environment_variables_projectId_scope_key_key" ON "environment_variables"("projectId", "scope", "key");

-- 4. Domains can target a specific web service; existing ones keep the primary.
ALTER TABLE "project_domains" ADD COLUMN "serviceId" UUID;
ALTER TABLE "project_domains" ADD CONSTRAINT "project_domains_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Service changes are audited.
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_DELETED';
