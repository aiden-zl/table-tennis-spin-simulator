import type { BallState } from '../physics/ball';
import type { ReturnResult } from '../physics/trajectory';
import type { CoachReport } from '../contracts';
import type { PaddleControl } from './playerStroke';

export interface CoachRequest {
  id: number;
  contact: BallState;
  control: PaddleControl;
  actual: ReturnResult | null;
}
export type CoachResponse =
  | { id: number; report: CoachReport }
  | { id: number; error: string }
  | { id: number; stale: true };

/**
 * Asynchronous coach. `request` returns a promise of the report; if workers are unavailable it
 * resolves to null and the rally engine computes the report synchronously instead.
 */
export class CoachClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, (r: CoachReport | null) => void>();
  /** called once if the worker breaks (load/parse/runtime error): switch to synchronous coaching */
  onFail: (() => void) | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL('./coachWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<CoachResponse>) => {
        const done = this.waiting.get(e.data.id);
        if (!done) return;
        this.waiting.delete(e.data.id);
        if ('report' in e.data) done(e.data.report);
        else if ('stale' in e.data) done(null);
        else {
          console.warn('coach worker failed', e.data.error);
          done(null);
        }
      };
      // load and JIT the worker's modules now, not on the first hit
      this.worker.postMessage({ warm: true });
      this.worker.onmessageerror = () => {
        console.warn('coach worker reply could not be decoded');
        this.fail();
      };
      this.worker.onerror = (e) => {
        console.warn('coach worker error', e.message);
        this.fail();
      };
    } catch (e) {
      console.warn('coach worker unavailable', e);
      this.worker = null;
    }
  }

  /** a worker is running (otherwise request() always resolves null) */
  get available(): boolean {
    return this.worker !== null;
  }

  request(contact: BallState, control: PaddleControl, actual: ReturnResult | null): Promise<CoachReport | null> {
    if (!this.worker) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker!.postMessage({ id, contact, control, actual } satisfies CoachRequest);
    });
  }

  /** worker broke: resolve everything pending with null (sync fallback) and stop using it */
  private fail(): void {
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
    const wasRunning = this.worker !== null;
    this.worker?.terminate();
    this.worker = null;
    if (wasRunning) this.onFail?.();
  }
}
