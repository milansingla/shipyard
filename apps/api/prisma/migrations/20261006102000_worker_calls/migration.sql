-- Engine operations the control plane sends to workers, and what workers need for remote routing.


-- CreateEnum
CREATE TYPE "WorkerCallStatus" AS ENUM ('PENDING', 'TAKEN', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "hostPorts" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "address" TEXT;

-- CreateTable
CREATE TABLE "worker_calls" (
    "id" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "status" "WorkerCallStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "worker_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_calls_workerId_status_createdAt_idx" ON "worker_calls"("workerId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "worker_calls" ADD CONSTRAINT "worker_calls_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

