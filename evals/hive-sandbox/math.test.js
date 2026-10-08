import test from 'node:test';
import assert from 'node:assert/strict';
import {clamp} from './math.js';

test('clamp keeps values inside the bounds', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(12, 0, 10), 10);
});
