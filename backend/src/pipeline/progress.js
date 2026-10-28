import { EventEmitter } from 'node:events';

export const STAGES = ['product', 'analysis', 'instagram', 'meta', 'scoring'];

// In-memory live state per search, streamed over SSE. The database holds the durable result.
export function createProgressHub() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const snapshots = new Map();

  const blank = () => ({
    status: 'queued',
    stages: Object.fromEntries(STAGES.map((stage) => [stage, { status: 'pending', message: '' }])),
  });

  return {
    snapshot(searchId) {
      return snapshots.get(searchId) ?? null;
    },
    init(searchId) {
      snapshots.set(searchId, blank());
      emitter.emit(searchId, snapshots.get(searchId));
    },
    stage(searchId, stage, patch) {
      const state = snapshots.get(searchId) ?? blank();
      state.status = state.status === 'queued' ? 'running' : state.status;
      state.stages[stage] = { ...state.stages[stage], ...patch };
      snapshots.set(searchId, state);
      emitter.emit(searchId, state);
    },
    finish(searchId, status) {
      const state = snapshots.get(searchId) ?? blank();
      state.status = status;
      emitter.emit(searchId, state);
      // Keep finished snapshots briefly for late subscribers, then let the DB answer.
      setTimeout(() => snapshots.delete(searchId), 5 * 60_000).unref();
    },
    subscribe(searchId, listener) {
      emitter.on(searchId, listener);
      return () => emitter.off(searchId, listener);
    },
  };
}
