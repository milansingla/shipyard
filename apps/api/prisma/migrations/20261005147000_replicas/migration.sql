-- Services can run several identical containers; each deployment records how many it started.

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "replicas" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "replicas" INTEGER NOT NULL DEFAULT 1;

-- A replica count is a small positive number; databases always run one.
ALTER TABLE "services" ADD CONSTRAINT "services_replicas_range" CHECK ("replicas" BETWEEN 1 AND 10);
ALTER TABLE "services" ADD CONSTRAINT "services_postgres_single_replica" CHECK ("type" <> 'POSTGRES' OR "replicas" = 1);
