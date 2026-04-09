/**
 * Maps channel-specific thread/conversation IDs to Claude Managed Agent session IDs.
 * In-memory only (no persistence).
 */

export interface SessionEntry {
  sessionId: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface SessionManagerOptions {
  /** Time-to-live in milliseconds. Sessions older than this (since last access) are expired. 0 = no expiry. */
  ttlMs?: number;
}

export class SessionManager {
  /** Map from "channelType:channelId:threadId" -> SessionEntry */
  private sessions = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 0;
  }

  private makeKey(channelType: string, channelId: string, threadId: string): string {
    return `${channelType}:${channelId}:${threadId}`;
  }

  private isExpired(entry: SessionEntry, now: number): boolean {
    if (this.ttlMs <= 0) return false;
    return now - entry.lastAccessedAt > this.ttlMs;
  }

  /**
   * Get an existing session ID for a thread, or undefined if none exists or expired.
   */
  getSession(channelType: string, channelId: string, threadId: string): string | undefined {
    const key = this.makeKey(channelType, channelId, threadId);
    const entry = this.sessions.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (this.isExpired(entry, now)) {
      this.sessions.delete(key);
      return undefined;
    }

    // Touch last accessed time
    entry.lastAccessedAt = now;
    return entry.sessionId;
  }

  /**
   * Store a session ID for a thread.
   */
  setSession(channelType: string, channelId: string, threadId: string, sessionId: string): void {
    const now = Date.now();
    this.sessions.set(this.makeKey(channelType, channelId, threadId), {
      sessionId,
      createdAt: now,
      lastAccessedAt: now,
    });
  }

  /**
   * Check if a session exists for a thread (and is not expired).
   */
  hasSession(channelType: string, channelId: string, threadId: string): boolean {
    const key = this.makeKey(channelType, channelId, threadId);
    const entry = this.sessions.get(key);
    if (!entry) return false;
    if (this.isExpired(entry, Date.now())) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get the total number of active sessions (includes potentially expired but not yet cleaned).
   * Call cleanup() first for an accurate count.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Delete a session for a thread. Returns true if the session existed.
   */
  deleteSession(channelType: string, channelId: string, threadId: string): boolean {
    return this.sessions.delete(this.makeKey(channelType, channelId, threadId));
  }

  /**
   * Remove all expired sessions. Returns the number of sessions removed.
   */
  cleanup(): number {
    if (this.ttlMs <= 0) return 0;
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.sessions) {
      if (this.isExpired(entry, now)) {
        this.sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Get the session entry with metadata (for diagnostics). Returns undefined if not found or expired.
   */
  getSessionEntry(channelType: string, channelId: string, threadId: string): SessionEntry | undefined {
    const key = this.makeKey(channelType, channelId, threadId);
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry, Date.now())) {
      this.sessions.delete(key);
      return undefined;
    }
    return { ...entry };
  }
}
