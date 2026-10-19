// A local, scripted stand-in for Nebius Token Factory (OpenAI-compatible chat completions, streaming or not).
// Tests drive the real agent with it: no network, no key, no cost. Never a real model call.
import http from 'node:http';

// agent: the main agent's replies in order, each { content } and/or { tools: [[name, args], ...] }.
// merchant: the merchant agents' JSON replies in order. rewrite: what any rewriting call answers.
export async function startMock({ agent = [], merchant = [], rewrite = 'ok', usage = { prompt_tokens: 1000, completion_tokens: 100 } } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      const sys = body.messages?.find((m) => m.role === 'system')?.content || '';
      const text = typeof sys === 'string' ? sys : '';
      let msg;
      if (body.tools?.length && /You are Mandat/.test(text)) {
        const step = agent.shift() || { content: 'All done.' };
        msg = { role: 'assistant', content: step.content || '' };
        if (step.tools) msg.tool_calls = step.tools.map(([name, args], i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      } else if (/AI sales agent/.test(text)) {
        msg = { role: 'assistant', content: JSON.stringify(merchant.shift() || { reply: 'Yes.', offer: null }) };
      } else if (/senior planner/.test(text)) {
        msg = { role: 'assistant', content: '{"missing":[],"issues":[]}' };
      } else {
        msg = { role: 'assistant', content: body.response_format ? '{}' : typeof rewrite === 'function' ? rewrite(body) : rewrite };
      }
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: msg }], usage }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (msg.content) send({ choices: [{ delta: { content: msg.content } }] });
      (msg.tool_calls || []).forEach((tc, index) => send({ choices: [{ delta: { tool_calls: [{ index, id: tc.id, function: tc.function }] } }] }));
      send({ choices: [], usage });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); // a failing test never leaves the process hanging on the mock
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, requests, agent, merchant, close: () => new Promise((r) => server.close(r)) };
}

// The environment every agent test runs in: the mock, offline PayPal, a throwaway data folder.
export async function useMock(script) {
  const mock = await startMock(script);
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  Object.assign(process.env, {
    LLM_BASE_URL: mock.url, NEBIUS_API_KEY: 'test-key-not-real', MANDAT_STORE: 'off', PAYPAL_KEY_FILE: '/nonexistent',
    MANDAT_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-test-')), MANDAT_KEEPALIVE: 'off',
  });
  for (const k of ['GOOGLE_PLACES_KEY', 'CHANNEL3_API_KEY', 'R2_ACCOUNT_ID', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY']) delete process.env[k];
  if (!/^http:\/\/127\.0\.0\.1:/.test(process.env.LLM_BASE_URL)) throw new Error('Tests never call a real provider');
  return mock;
}
