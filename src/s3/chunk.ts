import type { Env } from "../types";
export function getChunkSize(env: { CHUNK_SIZE?: string }): number {
  const v = env.CHUNK_SIZE ? parseInt(env.CHUNK_SIZE, 10) : 48 * 1024 * 1024;
  if (Number.isNaN(v) || v <= 0) return 48 * 1024 * 1024;
  return Math.min(Math.max(v, 5 * 1024), 90 * 1024 * 1024);
}
