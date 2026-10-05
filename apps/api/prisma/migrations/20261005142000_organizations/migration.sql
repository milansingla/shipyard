-- Teams: organizations own projects; access comes from membership.
-- Hand-written so existing data moves instead of being dropped: every user
-- gets a personal organization they OWN, and their projects move into it.

CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER');

CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

CREATE TABLE "memberships" (
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memberships_pkey" PRIMARY KEY ("organizationId","userId")
);
CREATE INDEX "memberships_userId_idx" ON "memberships"("userId");
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1. A personal organization per existing user (GitHub logins are unique case-insensitively).
CREATE TEMPORARY TABLE personal_orgs AS
  SELECT gen_random_uuid() AS "organizationId", u."id" AS "userId", u."login"
  FROM "users" u;
INSERT INTO "organizations" ("id", "name", "slug", "personal")
  SELECT "organizationId", "login", 'user-' || lower("login"), true FROM personal_orgs;
INSERT INTO "memberships" ("organizationId", "userId", "role")
  SELECT "organizationId", "userId", 'OWNER' FROM personal_orgs;

-- 2. Projects move to their owner's personal organization; the owner is kept as creator.
ALTER TABLE "projects" ADD COLUMN "organizationId" UUID, ADD COLUMN "createdById" UUID;
UPDATE "projects" p SET "organizationId" = o."organizationId", "createdById" = p."ownerId"
  FROM personal_orgs o WHERE o."userId" = p."ownerId";
ALTER TABLE "projects" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "projects" DROP CONSTRAINT "projects_ownerId_fkey";
DROP INDEX "projects_ownerId_createdAt_idx";
ALTER TABLE "projects" DROP COLUMN "ownerId";
CREATE INDEX "projects_organizationId_createdAt_idx" ON "projects"("organizationId", "createdAt" DESC);
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Audit entries belonged to a user; now to that user's personal organization.
ALTER TABLE "audit_logs" ADD COLUMN "organizationId" UUID;
UPDATE "audit_logs" a SET "organizationId" = o."organizationId" FROM personal_orgs o WHERE o."userId" = a."ownerId";
DROP INDEX "audit_logs_ownerId_id_idx";
ALTER TABLE "audit_logs" DROP COLUMN "ownerId";
CREATE INDEX "audit_logs_organizationId_id_idx" ON "audit_logs"("organizationId", "id");

DROP TABLE personal_orgs;

-- 4. Team management is audited too.
ALTER TYPE "AuditAction" ADD VALUE 'ORGANIZATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_REMOVED';
