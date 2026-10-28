import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stagePresentation } from './stageStatus.js';

test('stage presentation distinguishes completed, partial, no matches, failed, and skipped', () => {
  assert.equal(stagePresentation({ status: 'completed' }).label, 'Completed');
  assert.equal(stagePresentation({ status: 'partial' }).label, 'Completed with partial results');
  assert.equal(stagePresentation({ status: 'no_matches' }).label, 'No matches found');
  assert.equal(stagePresentation({ status: 'failed' }).label, 'Failed');
  assert.equal(stagePresentation({ status: 'skipped' }).label, 'Skipped');
});

test('source stage presentation includes collected counts and retry availability', () => {
  const stage = stagePresentation({
    status: 'failed',
    stats: { accepted: 1, target: 20, fetched: 48, retryPossible: true },
  });
  assert.equal(stage.counts, '1 accepted / 20 target; 48 fetched');
  assert.equal(stage.retryPossible, true);
});

test('legacy done and warning progress states stay readable', () => {
  assert.equal(stagePresentation({ status: 'done' }).status, 'completed');
  assert.equal(stagePresentation({ status: 'warning' }).status, 'partial');
});