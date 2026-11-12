export const ACTIVITY_MAX_AGENTS: 128;
export const ACTIVITY_MAX_WORKFLOWS: 32;
export const ACTIVITY_ID_LIMIT: 128;
export const ACTIVITY_NAME_LIMIT: 80;
export const ACTIVITY_TASK_LIMIT: 240;
export const ACTIVITY_PHASE_LIMIT: 120;
export const ACTIVITY_MAX_BYTES: number;
export const ACTIVITY_RPC_TIMEOUT_MS: 250;

export function activitySnapshotIsCoherent(value: unknown): boolean;
export function readActivitySnapshot(value: unknown): unknown;
