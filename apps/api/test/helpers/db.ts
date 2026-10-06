import { type PrismaClient, createPrismaClient } from "../../src/db/prisma.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://shipyard:shipyard@127.0.0.1:5433/shipyard_test";

/** Safety net: test code resets/truncates — never let it point at a real database. */
export function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run tests against "${dbName}": test database names must end in _test.`);
  }
}

export function createTestPrisma(): PrismaClient {
  assertTestDatabase(TEST_DATABASE_URL);
  return createPrismaClient(TEST_DATABASE_URL);
}

export async function resetTables(prisma: PrismaClient): Promise<void> {
  await prisma.volume.deleteMany(); // restricts service deletion: data is never removed implicitly
  await prisma.deployment.deleteMany();
  await prisma.worker.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.notificationChannel.deleteMany();
  await prisma.metricSample.deleteMany();
  await prisma.project.deleteMany();
  await prisma.organization.deleteMany(); // memberships cascade
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
}
