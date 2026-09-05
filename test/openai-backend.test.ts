import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createBackend, type ResolvedProvider } from '../src/chatBackends.ts';

/** Minimal fake OpenAI-compatible /chat/completions that streams canned SSE. */
function fakeServer(scripts: string[][]): Promise<{ url: string; bodies: unknown[]; close: () => void }> {
  const bodies: unknown[] = [];
  let call = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const frames = scripts[Math.min(call++, scripts.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/v1`, bodies, close: () => server.close() });
    });
  });
}

const rp = (baseURL: string): ResolvedProvider => ({
  provider: 'custom',
  kind: 'openai',
  model: 'fake-1',
  baseURL,
  apiKey: 'test',
});

test('OpenAI backend accumulates streamed tool_call argument deltas', async () => {
  const toolCallFrames = [
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'soqlQuery', arguments: '' } }] } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"soql":"SELECT ' } }] } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Id FROM Account"}' } }] } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const answerFrames = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'There are 3 accounts.' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ];
  const srv = await fakeServer([toolCallFrames, answerFrames]);
  try {
    const backend = createBackend(rp(srv.url), 'system', [
      { name: 'soqlQuery', description: 'run soql', parameters: { type: 'object' } },
    ]);

    let streamed = '';
    const first = await backend.turn({ userText: 'how many accounts?' }, (d) => (streamed += d));
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0].name, 'soqlQuery');
    assert.deepEqual(first.toolCalls[0].input, { soql: 'SELECT Id FROM Account' });
    assert.equal(streamed, '');

    const second = await backend.turn(
      { toolOutcomes: [{ id: first.toolCalls[0].id, content: '{"totalSize":3}' }] },
      (d) => (streamed += d),
    );
    assert.equal(second.toolCalls.length, 0);
    assert.equal(streamed, 'There are 3 accounts.');

    // Second request must carry the assistant tool_call and the tool result.
    const body2 = srv.bodies[1] as { messages: Array<{ role: string; tool_call_id?: string }> };
    assert.equal(body2.messages.at(-2)?.role, 'assistant');
    assert.equal(body2.messages.at(-1)?.role, 'tool');
    assert.equal(body2.messages.at(-1)?.tool_call_id, 'call_1');
  } finally {
    srv.close();
  }
});
