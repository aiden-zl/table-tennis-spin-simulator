/// <reference lib="webworker" />
/**
 * Runs the coach (≈50-400 ms of grid search per ball) off the main thread. main.ts posts the
 * contact the instant the player hits, so the report is normally ready before the return
 * lands and the result card appears without a frame hitch.
 *
 * Requests are queued and only the NEWEST is analysed: older ones (a ball that was replaced
 * before its analysis started) are answered with `stale` so the client can drop them.
 */
import { analyzeReturn } from './coach';
import type { CoachRequest, CoachResponse } from './coachClient';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let queue: CoachRequest[] = [];
let scheduled = false;

function drain(): void {
  scheduled = false;
  const latest = queue[queue.length - 1];
  for (const r of queue.slice(0, -1)) scope.postMessage({ id: r.id, stale: true } satisfies CoachResponse);
  queue = [];
  if (!latest) return;
  let msg: CoachResponse;
  try {
    msg = { id: latest.id, report: analyzeReturn(latest.contact, latest.control, latest.actual) };
  } catch (err) {
    msg = { id: latest.id, error: String(err) };
  }
  scope.postMessage(msg);
}

scope.onmessage = (e: MessageEvent<CoachRequest | { warm: true }>) => {
  if ('warm' in e.data) return;
  queue.push(e.data);
  // let any messages already waiting arrive first, then analyse only the newest
  if (!scheduled) {
    scheduled = true;
    setTimeout(drain, 0);
  }
};
