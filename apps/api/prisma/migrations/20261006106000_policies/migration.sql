-- Organization policies and deploy approval.


-- AlterEnum


ALTER TYPE "AuditAction" ADD VALUE 'POLICY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'DEPLOYMENT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'DEPLOYMENT_REJECTED';

-- AlterEnum
ALTER TYPE "DeployJobStatus" ADD VALUE 'AWAITING_APPROVAL';

-- AlterTable
ALTER TABLE "deploy_jobs" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" UUID;

-- CreateTable
CREATE TABLE "organization_policies" (
    "organizationId" UUID NOT NULL,
    "maxMemoryMb" INTEGER,
    "maxCpu" DOUBLE PRECISION,
    "maxReplicas" INTEGER,
    "requireHealthCheckPath" BOOLEAN NOT NULL DEFAULT false,
    "allowedDomainSuffixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_policies_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

