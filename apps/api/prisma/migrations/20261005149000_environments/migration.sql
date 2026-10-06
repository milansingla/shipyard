-- Environments besides production (development, pull-request previews), and variables per environment.
-- Existing rows keep their meaning: deployments with no environment are production, variables apply to ALL.


-- CreateEnum
CREATE TYPE "VariableEnvironment" AS ENUM ('ALL', 'PRODUCTION', 'PREVIEW', 'DEVELOPMENT');

-- CreateEnum
CREATE TYPE "EnvironmentType" AS ENUM ('DEVELOPMENT', 'PREVIEW');

-- CreateEnum
CREATE TYPE "EnvironmentStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- DropIndex
DROP INDEX "environment_variables_projectId_scope_key_key";

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "environmentId" UUID;

-- AlterTable
ALTER TABLE "environment_variables" ADD COLUMN     "environment" "VariableEnvironment" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "previewDeployments" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "EnvironmentType" NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "pullRequest" INTEGER,
    "title" TEXT,
    "status" "EnvironmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "environments_projectId_name_key" ON "environments"("projectId", "name");

-- CreateIndex
CREATE INDEX "deployments_environmentId_createdAt_idx" ON "deployments"("environmentId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "environment_variables_projectId_scope_environment_key_key" ON "environment_variables"("projectId", "scope", "environment", "key");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A preview belongs to a pull request.
ALTER TABLE "environments" ADD CONSTRAINT "environments_preview_has_pull_request" CHECK ("type" <> 'PREVIEW' OR "pullRequest" IS NOT NULL);
