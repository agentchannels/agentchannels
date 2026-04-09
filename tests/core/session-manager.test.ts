import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager } from '../../src/core/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  describe('session creation (setSession)', () => {
    it('stores a session mapping', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.hasSession('slack', 'C123', 'ts1')).toBe(true);
    });

    it('overwrites existing session for the same thread', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      manager.setSession('slack', 'C123', 'ts1', 'session-xyz');
      expect(manager.getSession('slack', 'C123', 'ts1')).toBe('session-xyz');
    });

    it('increments size on set', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.size).toBe(1);
      manager.setSession('slack', 'C123', 'ts2', 'session-def');
      expect(manager.size).toBe(2);
    });

    it('does not increment size when overwriting', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      manager.setSession('slack', 'C123', 'ts1', 'session-xyz');
      expect(manager.size).toBe(1);
    });
  });

  describe('session lookup (getSession)', () => {
    it('returns undefined for unknown thread', () => {
      expect(manager.getSession('slack', 'C123', 'ts1')).toBeUndefined();
    });

    it('returns session ID after set', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.getSession('slack', 'C123', 'ts1')).toBe('session-abc');
    });

    it('returns undefined for partially matching keys', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.getSession('slack', 'C123', 'ts2')).toBeUndefined();
      expect(manager.getSession('slack', 'C999', 'ts1')).toBeUndefined();
      expect(manager.getSession('discord', 'C123', 'ts1')).toBeUndefined();
    });
  });

  describe('mapping isolation (channel/thread IDs)', () => {
    it('isolates sessions by channel type', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-slack');
      manager.setSession('discord', 'C123', 'ts1', 'session-discord');
      expect(manager.getSession('slack', 'C123', 'ts1')).toBe('session-slack');
      expect(manager.getSession('discord', 'C123', 'ts1')).toBe('session-discord');
    });

    it('isolates sessions by channel ID', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-a');
      manager.setSession('slack', 'C456', 'ts1', 'session-b');
      expect(manager.getSession('slack', 'C123', 'ts1')).toBe('session-a');
      expect(manager.getSession('slack', 'C456', 'ts1')).toBe('session-b');
    });

    it('isolates sessions by thread ID', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-a');
      manager.setSession('slack', 'C123', 'ts2', 'session-b');
      expect(manager.getSession('slack', 'C123', 'ts1')).toBe('session-a');
      expect(manager.getSession('slack', 'C123', 'ts2')).toBe('session-b');
    });

    it('correctly maps composite keys with special characters', () => {
      manager.setSession('slack', 'C:123', 'ts:1', 'session-special');
      expect(manager.getSession('slack', 'C:123', 'ts:1')).toBe('session-special');
    });

    it('handles many concurrent sessions across channels', () => {
      for (let i = 0; i < 100; i++) {
        manager.setSession('slack', `C${i}`, `ts${i}`, `session-${i}`);
      }
      expect(manager.size).toBe(100);
      expect(manager.getSession('slack', 'C50', 'ts50')).toBe('session-50');
      expect(manager.getSession('slack', 'C99', 'ts99')).toBe('session-99');
    });
  });

  describe('deleteSession', () => {
    it('returns false when deleting non-existent session', () => {
      expect(manager.deleteSession('slack', 'C123', 'ts1')).toBe(false);
    });

    it('returns true when deleting existing session', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.deleteSession('slack', 'C123', 'ts1')).toBe(true);
    });

    it('removes the session so get returns undefined', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      manager.deleteSession('slack', 'C123', 'ts1');
      expect(manager.getSession('slack', 'C123', 'ts1')).toBeUndefined();
    });

    it('does not affect other sessions', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-a');
      manager.setSession('slack', 'C123', 'ts2', 'session-b');
      manager.deleteSession('slack', 'C123', 'ts1');
      expect(manager.getSession('slack', 'C123', 'ts2')).toBe('session-b');
    });

    it('decrements size on delete', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      manager.deleteSession('slack', 'C123', 'ts1');
      expect(manager.size).toBe(0);
    });
  });

  describe('hasSession', () => {
    it('returns false for unknown thread', () => {
      expect(manager.hasSession('slack', 'C123', 'ts1')).toBe(false);
    });

    it('returns true for known thread', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.hasSession('slack', 'C123', 'ts1')).toBe(true);
    });

    it('returns false after delete', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      manager.deleteSession('slack', 'C123', 'ts1');
      expect(manager.hasSession('slack', 'C123', 'ts1')).toBe(false);
    });
  });

  describe('size', () => {
    it('starts at 0', () => {
      expect(manager.size).toBe(0);
    });

    it('increments on set', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      expect(manager.size).toBe(1);
    });

    it('decrements on delete', () => {
      manager.setSession('slack', 'C123', 'ts1', 'session-abc');
      manager.deleteSession('slack', 'C123', 'ts1');
      expect(manager.size).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all sessions', () => {
      manager.setSession('slack', 'C1', 'ts1', 's1');
      manager.setSession('slack', 'C2', 'ts2', 's2');
      manager.clear();
      expect(manager.size).toBe(0);
      expect(manager.getSession('slack', 'C1', 'ts1')).toBeUndefined();
    });

    it('allows new sessions after clear', () => {
      manager.setSession('slack', 'C1', 'ts1', 's1');
      manager.clear();
      manager.setSession('slack', 'C1', 'ts1', 's2');
      expect(manager.getSession('slack', 'C1', 'ts1')).toBe('s2');
    });
  });

  describe('session cleanup/expiry logic', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not expire sessions when ttlMs is 0 (default)', () => {
      const noTtl = new SessionManager();
      noTtl.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(999_999_999);
      expect(noTtl.getSession('slack', 'C1', 'ts1')).toBe('s1');
    });

    it('returns session before TTL expires', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(30_000); // 30s < 60s TTL
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBe('s1');
    });

    it('expires sessions after TTL based on last access', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(61_000); // > 60s TTL
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBeUndefined();
    });

    it('hasSession returns false for expired sessions', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(61_000);
      expect(ttlManager.hasSession('slack', 'C1', 'ts1')).toBe(false);
    });

    it('touching a session (via getSession) resets expiry', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');

      // Advance 50s and touch
      vi.advanceTimersByTime(50_000);
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBe('s1');

      // Advance another 50s (100s total from creation, but only 50s since last touch)
      vi.advanceTimersByTime(50_000);
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBe('s1');

      // Now advance past TTL from last touch
      vi.advanceTimersByTime(61_000);
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBeUndefined();
    });

    it('cleanup() removes expired sessions and returns count', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      ttlManager.setSession('slack', 'C2', 'ts2', 's2');

      vi.advanceTimersByTime(61_000);
      const removed = ttlManager.cleanup();
      expect(removed).toBe(2);
      expect(ttlManager.size).toBe(0);
    });

    it('cleanup() only removes expired sessions, keeps active ones', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');

      vi.advanceTimersByTime(30_000);
      ttlManager.setSession('slack', 'C2', 'ts2', 's2'); // fresh session

      vi.advanceTimersByTime(31_000); // s1 is 61s old, s2 is 31s old
      const removed = ttlManager.cleanup();
      expect(removed).toBe(1);
      expect(ttlManager.size).toBe(1);
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBeUndefined();
      expect(ttlManager.getSession('slack', 'C2', 'ts2')).toBe('s2');
    });

    it('cleanup() returns 0 when no TTL configured', () => {
      const noTtl = new SessionManager();
      noTtl.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(999_999);
      expect(noTtl.cleanup()).toBe(0);
      expect(noTtl.size).toBe(1);
    });

    it('cleanup() returns 0 when nothing is expired', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(10_000);
      expect(ttlManager.cleanup()).toBe(0);
    });

    it('expired sessions are lazily cleaned on get/has', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(61_000);

      // size still reports 1 before lazy cleanup
      expect(ttlManager.size).toBe(1);

      // getSession triggers lazy delete
      expect(ttlManager.getSession('slack', 'C1', 'ts1')).toBeUndefined();
      expect(ttlManager.size).toBe(0);
    });

    it('expired sessions are lazily cleaned on hasSession', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(61_000);

      expect(ttlManager.hasSession('slack', 'C1', 'ts1')).toBe(false);
      expect(ttlManager.size).toBe(0);
    });
  });

  describe('getSessionEntry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns undefined for non-existent session', () => {
      expect(manager.getSessionEntry('slack', 'C1', 'ts1')).toBeUndefined();
    });

    it('returns entry with session metadata', () => {
      const now = Date.now();
      manager.setSession('slack', 'C1', 'ts1', 's1');
      const entry = manager.getSessionEntry('slack', 'C1', 'ts1');
      expect(entry).toBeDefined();
      expect(entry!.sessionId).toBe('s1');
      expect(entry!.createdAt).toBe(now);
      expect(entry!.lastAccessedAt).toBe(now);
    });

    it('returns a copy (not a reference)', () => {
      manager.setSession('slack', 'C1', 'ts1', 's1');
      const entry1 = manager.getSessionEntry('slack', 'C1', 'ts1');
      const entry2 = manager.getSessionEntry('slack', 'C1', 'ts1');
      expect(entry1).not.toBe(entry2);
      expect(entry1).toEqual(entry2);
    });

    it('returns undefined for expired session', () => {
      const ttlManager = new SessionManager({ ttlMs: 60_000 });
      ttlManager.setSession('slack', 'C1', 'ts1', 's1');
      vi.advanceTimersByTime(61_000);
      expect(ttlManager.getSessionEntry('slack', 'C1', 'ts1')).toBeUndefined();
    });
  });
});
