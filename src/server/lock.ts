import { DatabaseSync } from 'node:sqlite';

/**
 * Hold an OS-backed SQLite exclusive lock in a separate guard database.
 * The board keeps its own short transactions. A crashed process releases this
 * guard automatically, without PID files, stale-file deletion races or ports.
 * Both files must live on local disk, never a network filesystem.
 */
export function acquireDaemonLock(path: string): () => void {
  const guard = new DatabaseSync(path);
  try {
    guard.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
  } catch {
    guard.close();
    throw new Error(
      'Another daemon owns this data directory, or its lock cannot be acquired. Use that daemon, stop it first, or select another local data directory.',
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      guard.exec('ROLLBACK');
    } finally {
      guard.close();
    }
  };
}
