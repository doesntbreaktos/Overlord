import { db } from "../connection";
import "../schema";

export type SharedFileRecord = {
  id: string;
  filename: string;
  storedPath: string;
  size: number;
  mimeType: string;
  uploadedBy: number;
  uploadedByUsername: string;
  passwordHash: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: number | null;
  createdAt: number;
  description: string | null;
};

export function insertSharedFile(file: SharedFileRecord): void {
  db.run(
    `INSERT INTO shared_files (id, filename, stored_path, size, mime_type, uploaded_by, uploaded_by_username, password_hash, max_downloads, download_count, expires_at, created_at, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    file.id,
    file.filename,
    file.storedPath,
    file.size,
    file.mimeType,
    file.uploadedBy,
    file.uploadedByUsername,
    file.passwordHash,
    file.maxDownloads,
    file.downloadCount,
    file.expiresAt,
    file.createdAt,
    file.description,
  );
}

export function getSharedFile(id: string): SharedFileRecord | null {
  const row = db.query<any>(`SELECT * FROM shared_files WHERE id=?`).get(id);
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    storedPath: row.stored_path,
    size: row.size,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    uploadedByUsername: row.uploaded_by_username,
    passwordHash: row.password_hash,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    description: row.description,
  };
}

export function listSharedFiles(): SharedFileRecord[] {
  return db
    .query<any>(`SELECT * FROM shared_files ORDER BY created_at DESC`)
    .all()
    .map((row: any) => ({
      id: row.id,
      filename: row.filename,
      storedPath: row.stored_path,
      size: row.size,
      mimeType: row.mime_type,
      uploadedBy: row.uploaded_by,
      uploadedByUsername: row.uploaded_by_username,
      passwordHash: row.password_hash,
      maxDownloads: row.max_downloads,
      downloadCount: row.download_count,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      description: row.description,
    }));
}

export function deleteSharedFile(id: string): boolean {
  const result = db.run(`DELETE FROM shared_files WHERE id=?`, id);
  return (result as any)?.changes ? (result as any).changes > 0 : false;
}

export function updateSharedFile(
  id: string,
  updates: {
    passwordHash?: string | null;
    maxDownloads?: number | null;
    expiresAt?: number | null;
    description?: string | null;
  },
): boolean {
  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.passwordHash !== undefined) {
    setClauses.push("password_hash=?");
    values.push(updates.passwordHash);
  }
  if (updates.maxDownloads !== undefined) {
    setClauses.push("max_downloads=?");
    values.push(updates.maxDownloads);
  }
  if (updates.expiresAt !== undefined) {
    setClauses.push("expires_at=?");
    values.push(updates.expiresAt);
  }
  if (updates.description !== undefined) {
    setClauses.push("description=?");
    values.push(updates.description);
  }

  if (setClauses.length === 0) return false;

  values.push(id);
  const result = db.run(
    `UPDATE shared_files SET ${setClauses.join(", ")} WHERE id=?`,
    ...values,
  );
  return (result as any)?.changes ? (result as any).changes > 0 : false;
}

export function incrementSharedFileDownloadCount(id: string): boolean {
  const result = db.run(
    `UPDATE shared_files SET download_count = download_count + 1 WHERE id=?`,
    id,
  );
  return (result as any)?.changes ? (result as any).changes > 0 : false;
}

/**
 * Atomically reserves one download while enforcing expiry and max-downloads.
 * The conditional UPDATE prevents concurrent requests from all observing the
 * same stale download_count and overshooting the configured limit.
 */
export function claimSharedFileDownload(id: string, now = Date.now()): boolean {
  const result = db.run(
    `UPDATE shared_files
       SET download_count = download_count + 1
     WHERE id=?
       AND (expires_at IS NULL OR expires_at >= ?)
       AND (max_downloads IS NULL OR download_count < max_downloads)`,
    id,
    now,
  );
  return result.changes > 0;
}

export function deleteExpiredSharedFiles(): string[] {
  const now = Date.now();
  const expired = db
    .query<any>(`SELECT id, stored_path FROM shared_files WHERE expires_at IS NOT NULL AND expires_at < ?`)
    .all(now);
  const ids = expired.map((r: any) => r.id);
  const paths = expired.map((r: any) => r.stored_path);
  if (ids.length > 0) {
    for (const id of ids) {
      db.run(`DELETE FROM shared_files WHERE id=?`, id);
    }
  }
  return paths;
}
