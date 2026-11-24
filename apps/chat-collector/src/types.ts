import type { RawPacket } from 'soop-chat';

export const DAY_MS = 86_400_000;
export const MAX_RETENTION_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS);

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type StorageErrorDetails = {
  databaseOperation?: string;
  errorCode?: string;
  sqliteCode?: number;
  statusCode?: number;
  workerExitCode?: number;
  pendingWrites?: number;
  writeLimit?: number;
};

export class StorageError extends ApiError {
  readonly details: StorageErrorDetails;

  constructor(
    statusCode: number,
    message: string,
    details: StorageErrorDetails,
  ) {
    super(statusCode, message);
    this.details = details;
  }
}

export function storageErrorDetails(error: unknown): StorageErrorDetails {
  if (error instanceof StorageError) return error.details;
  if (error instanceof ApiError) return { statusCode: error.statusCode };
  const details: StorageErrorDetails = {};
  if (error instanceof Error) {
    if ('code' in error && typeof error.code === 'string')
      details.errorCode = error.code;
    if ('errcode' in error && typeof error.errcode === 'number')
      details.sqliteCode = error.errcode;
  }
  return details;
}

export type Streamer = {
  streamer_id: string;
  room_password: string | null;
  retention_days: number;
  registered: number;
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type Broadcast = {
  broadcast_no: string;
  streamer_id: string;
  first_collected_at: number;
  last_collected_at: number;
  ended_at: number | null;
  event_count: number;
};

export function compareBroadcasts(a: Broadcast, b: Broadcast) {
  return (
    b.first_collected_at - a.first_collected_at ||
    a.streamer_id.localeCompare(b.streamer_id) ||
    a.broadcast_no.localeCompare(b.broadcast_no)
  );
}

export type StoredEvent = {
  type: string;
  opcode: string;
  receivedAt: number;
  data: unknown;
  raw: Pick<RawPacket, 'flags' | 'payload'>;
};
