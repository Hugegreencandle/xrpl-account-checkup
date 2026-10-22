import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../src/index.js';

test('library entry exports the public API', () => {
  for (const name of ['scanAccount', 'buildPlan', 'toBatches', 'giftTx', 'trustLineItem', 'rpc', 'rpcAll']) assert.equal(typeof lib[name], 'function', name);
  assert.equal(lib.MAX_BATCH, 8);
  assert.equal(lib.DEFAULT_SERVERS.length, 2);
});
