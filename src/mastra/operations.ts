import { existsSync, readFileSync } from 'node:fs';

export interface ExecutionGuard { enter(): () => void }

/** Only Studio injects this guard. Task services retain their own scheduler. */
export class StudioGate implements ExecutionGuard {
  private active = new Set<symbol>();
  constructor(private readonly draining = () => !!process.env.STUDIO_DRAIN_FILE && existsSync(process.env.STUDIO_DRAIN_FILE)) {}
  enter() {
    if (this.draining()) throw new Error('STUDIO_DRAINING');
    const ticket = Symbol(); this.active.add(ticket);
    return () => { this.active.delete(ticket); };
  }
  status() { return { draining: this.draining(), activeRuns: this.active.size }; }
}

export function studioBuildInfo() {
  const path = process.env.STUDIO_BUILD_INFO || './build-info.json';
  if (!existsSync(path)) return { commit: 'development', release: 'development' };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value.commit !== 'string' || typeof value.release !== 'string') throw new Error('INVALID_BUILD_INFO');
  return { commit: value.commit, release: value.release };
}
