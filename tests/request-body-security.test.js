import test from 'node:test';
import assert from 'node:assert/strict';
import { readJSONBody } from '../lib/request-security.js';
import worker, { toolDefs } from '../worker/index.js';

function streamedBody(chunks, headers = {}) {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (pulls === chunks.length) controller.close();
      else controller.enqueue(chunks[pulls++]);
    },
    cancel() { cancelled = true; },
  });
  return {
    request: new Request('https://private.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' }),
    progress: () => ({ pulls, cancelled }),
  };
}

test('oversized unknown-length MCP body is cancelled before buffering the whole stream', async () => {
  const input = streamedBody(Array.from({ length: 100 }, () => new Uint8Array(16384).fill(32)));
  const response = await worker.fetch(input.request, {});
  assert.equal(response.status, 413);
  assert.ok(input.progress().pulls < 10);
  assert.equal(input.progress().cancelled, true);
});

test('the byte limit cannot be bypassed by a false Content-Length or multibyte JSON', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: 'é'.repeat(35000) }));
  assert.ok(bytes.byteLength > 70000);
  const input = streamedBody([bytes], { 'content-length': '2' });
  await assert.rejects(readJSONBody(input.request), e => e.status === 413);
  assert.equal(input.progress().cancelled, true);
});

test('valid UTF-8 split across chunks and exact-limit JSON remain readable', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: 'é' }));
  const input = streamedBody(Array.from(bytes, byte => Uint8Array.of(byte)));
  assert.deepEqual(await readJSONBody(input.request), { value: 'é' });
  const exact = '"' + 'a'.repeat(69998) + '"';
  assert.equal((await readJSONBody(streamedBody([new TextEncoder().encode(exact)]).request)).length, 69998);
  await assert.rejects(readJSONBody(streamedBody([new TextEncoder().encode('{')]).request), e => e.status === 400);
});

test('every advertised MCP operation rejects missing identity before touching storage', async () => {
  const env = { get DB() { throw new Error('Storage must not be reached'); } };
  for (const tool of toolDefs) {
    const operations = tool.inputSchema.properties.operation?.enum || [undefined];
    for (const operation of operations) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: { operation } } });
      const response = await worker.fetch(new Request('https://private.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), env);
      const result = (await response.json()).result;
      assert.equal(result.isError, true, tool.name + ':' + operation);
      assert.match(result.content[0].text, /Sign in/, tool.name + ':' + operation);
    }
  }
});
