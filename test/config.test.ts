import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerUrl, envFromUrl } from '../src/config.ts';

test('resolveServerUrl: production has no tier prefix', () => {
  assert.equal(
    resolveServerUrl('sobject-reads', 'platform'),
    'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads',
  );
});

test('resolveServerUrl: sandbox inserts the sandbox segment before the group', () => {
  assert.equal(
    resolveServerUrl('sobject-reads', 'sandbox'),
    'https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-reads',
  );
});

test('resolveServerUrl: group is overridable', () => {
  assert.equal(
    resolveServerUrl('data-cloud', 'platform', 'data-360'),
    'https://api.salesforce.com/platform/mcp/v1/data-360/data-cloud',
  );
});

test('envFromUrl distinguishes sandbox from production', () => {
  assert.equal(envFromUrl('https://api.salesforce.com/platform/mcp/v1/sandbox/platform/flows'), 'sandbox');
  assert.equal(envFromUrl('https://api.salesforce.com/platform/mcp/v1/platform/flows'), 'platform');
});
