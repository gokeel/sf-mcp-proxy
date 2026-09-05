import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolMap } from '../src/chat.ts';
import { formatToolResult, summarizeToolResult } from '../src/mcpClient.ts';

test('buildToolMap sanitizes names and keeps a reverse map', () => {
  const { specs, toMcpName } = buildToolMap([
    { name: 'sobject.query', description: 'run soql', inputSchema: { type: 'object' } },
    { name: 'sobject.query', description: 'dup' },
  ]);
  assert.equal(specs[0].name, 'sobject_query');
  assert.equal(toMcpName.get('sobject_query'), 'sobject.query');
  assert.notEqual(specs[1].name, specs[0].name, 'duplicate names are disambiguated');
  assert.equal(toMcpName.get(specs[1].name), 'sobject.query');
});

test('buildToolMap falls back to an object schema when none is given', () => {
  const { specs } = buildToolMap([{ name: 'x' }]);
  assert.deepEqual(specs[0].parameters, { type: 'object' });
});

test('formatToolResult renders text blocks and flags errors', () => {
  assert.equal(formatToolResult({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.match(formatToolResult({ isError: true, content: [{ type: 'text', text: 'bad' }] }), /reported an error/);
  assert.equal(formatToolResult({}), '(no content)');
});

test('summarizeToolResult truncates long output', () => {
  const long = 'a'.repeat(5000);
  const out = summarizeToolResult({ content: [{ type: 'text', text: long }] }, 100);
  assert.match(out, /truncated 4900 chars/);
});
