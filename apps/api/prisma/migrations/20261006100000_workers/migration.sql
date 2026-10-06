-- Workers: machines that run deployments (the control plane's built-in one, and registered ones).


-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ONLINE', 'DRAINING', 'OFFLINE');

-- CreateTable
CREATE TABLE "workers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "cpus" DOUBLE PRECISION NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ONLINE',
    "tokenHash" TEXT,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "runningJobs" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workers_name_key" ON "workers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "workers_tokenHash_key" ON "workers"("tokenHash");

-- CreateIndex
CREATE INDEX "workers_status_lastHeartbeatAt_idx" ON "workers"("status", "lastHeartbeatAt");


-- A worker reports what it has; nonsense is refused by the database too.
ALTER TABLE "workers" ADD CONSTRAINT "workers_capacity" CHECK ("cpus" > 0 AND "memoryMb" > 0 AND "runningJobs" >= 0);
