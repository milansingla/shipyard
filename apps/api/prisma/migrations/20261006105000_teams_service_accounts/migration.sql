-- Teams with project grants, service accounts (users without GitHub), and API key scopes.


-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('HUMAN', 'SERVICE_ACCOUNT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TEAM_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TEAM_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'TEAM_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_ACCOUNT_DELETED';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kind" "UserKind" NOT NULL DEFAULT 'HUMAN',
ALTER COLUMN "githubId" DROP NOT NULL,
ALTER COLUMN "githubAccessToken" DROP NOT NULL;

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateTable
CREATE TABLE "team_project_grants" (
    "teamId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,

    CONSTRAINT "team_project_grants_pkey" PRIMARY KEY ("teamId","projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_organizationId_name_key" ON "teams"("organizationId", "name");

-- CreateIndex
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- CreateIndex
CREATE INDEX "team_project_grants_projectId_idx" ON "team_project_grants"("projectId");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_project_grants" ADD CONSTRAINT "team_project_grants_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_project_grants" ADD CONSTRAINT "team_project_grants_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A team grant is at most ADMIN; a human has a GitHub account, a service account doesn't.
ALTER TABLE "team_project_grants" ADD CONSTRAINT "team_grant_not_owner" CHECK ("role" <> 'OWNER');
ALTER TABLE "users" ADD CONSTRAINT "users_kind_identity" CHECK (("kind" = 'HUMAN') = ("githubId" IS NOT NULL AND "githubAccessToken" IS NOT NULL));
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes" CHECK ("scopes" <@ ARRAY['read', 'deploy', 'write']::text[]);
