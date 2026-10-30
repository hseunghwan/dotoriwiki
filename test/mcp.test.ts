import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/http.ts';
import type { DomainName } from '../src/wiki/index.ts';
import { fakeLlm, listDir, open, readText, tempWiki } from './helpers.ts';

const TOKEN = 'test-token-0123456789';

async function serve() {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  const http = await startHttp(
    { wiki, chat: async function* () {}, token: TOKEN, serverVersion: '0.1.0', now: () => new Date('2026-10-29T00:00:00Z'), maxBodyBytes: 4096 },
    { host: '127.0.0.1', port: 0 },
  );
  const url = new URL(`http://127.0.0.1:${http.port}/mcp`);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { root, wiki, url, client, call, close: async () => (await client.close(), await http.close(), await wiki.close()) };
}

const context = { project: 'notes-app', cwd: '/Users/me/workspace/notes-app', branch: 'main' };

test('/mcp checks the token before any MCP handling, and refuses the GET stream', async () => {
  const s = await serve();
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
  const post = (headers: Record<string, string>) =>
    fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer wrong-token-0123456789' })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${TOKEN}` })).status, 200);
  assert.equal((await fetch(s.url, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } })).status, 405);
  await s.close();
});

test('write_memo lands as an agent memo with its context, through the same inbox as POST /memos', async () => {
  const s = await serve();
  const r = await s.call('write_memo', { text: 'RRF 상수는 60', context });
  assert.equal(r.status, 'accepted');
  assert.deepEqual(await listDir(join(s.root, 'inbox')), [`${r.id}.md`]);
  const raw = (await readText(join(s.root, 'inbox', `${r.id}.md`)))!;
  assert.equal(raw, [
    '---',
    `id: ${r.id}`,
    'captured_at: 2026-10-29T09:00:00+09:00',
    'tz: Asia/Seoul',
    'source: agent',
    'domain_hint: null',
    'context:',
    '  project: notes-app',
    '  cwd: /Users/me/workspace/notes-app',
    '  branch: main',
    '---',
    'RRF 상수는 60',
    '',
  ].join('\n'));
  await s.close();
});

test('write_memo rejects an unknown domain_hint and a bad context as tool errors, writing nothing', async () => {
  const s = await serve();
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['write_memo', 'memo_status']);
  assert.match(tools[0]!.description!, /one of: 일상, 스터디, 미루기 아카이빙\./, 'the domain list comes from the wiki');

  assert.deepEqual(await s.call('write_memo', { text: '메모', domain_hint: '개발소식' }), { error: 'domain_hint: one of 일상, 스터디, 미루기 아카이빙' });
  assert.deepEqual(await s.call('write_memo', { text: '메모', context: { project: 'x' } }), { error: 'context.cwd: required' });
  assert.deepEqual(await s.call('write_memo', { text: '  ' }), { error: 'text: required' });
  assert.deepEqual(await listDir(join(s.root, 'inbox')), []);
  await s.close();
});

test('memo_status follows a memo to its page, waits when asked, and errors on an unknown id', async () => {
  const s = await serve();
  const { id } = await s.call('write_memo', { text: '메모', domain_hint: '스터디', context });
  assert.deepEqual(await s.call('memo_status', { id }), { id, state: 'inbox', domain: null, verdict: null, first_page: null, failure: null });

  const waited = s.call('memo_status', { id, wait_seconds: 10 });
  assert.equal((await s.wiki.routeNext()).kind, 'routed');
  assert.equal((await s.wiki.runNext('스터디' as DomainName)).kind, 'committed');
  assert.deepEqual(await waited, { id, state: 'ingested', domain: '스터디', verdict: '새 페이지', first_page: `메모 ${id}`, failure: null });

  assert.deepEqual(await s.call('memo_status', { id: '01JB90A1C2D3E4F5G6H7J8K9ZZ' }), { error: 'no such memo' });
  assert.deepEqual(await s.call('memo_status', { id: '../etc' }), { error: 'id: expected the id write_memo returned' });
  assert.deepEqual(await s.call('memo_status', { id, wait_seconds: 60 }), { error: 'wait_seconds: 0 to 30' });
  await s.close();
});
