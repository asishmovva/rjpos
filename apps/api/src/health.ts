import { createConnection } from 'node:net';
import type { PrismaClient } from '@prisma/client';

export async function checkPostgres(prisma: PrismaClient): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

export async function checkRedis(url: string): Promise<boolean> {
  const address = new URL(url);
  const port = Number(address.port || 6379);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address.hostname, port });
    const finish = (error?: Error) => { socket.destroy(); error ? reject(error) : resolve(true); };
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
    socket.setTimeout(1000, () => finish(new Error('REDIS_TIMEOUT')));
  });
}
