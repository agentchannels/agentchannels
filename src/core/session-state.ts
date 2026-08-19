import type { SessionStatus } from "./types.js";

const transitions: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  queued: ["running", "failed", "stopped"],
  running: ["waiting", "completed", "interrupted", "failed", "stopped"],
  waiting: ["running", "interrupted", "failed", "stopped"],
  completed: ["queued"],
  interrupted: ["queued", "failed", "stopped"],
  failed: [],
  stopped: ["queued"],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to))
    throw new Error(`Invalid Session transition: ${from} -> ${to}`);
}
