/** Tests consumed by `claude plugin test`, using its real event engine and stubbed I/O. */
export const PEER_MOD_NATIVE_TESTS = String.raw`
import { expect, mock, test } from 'claude-code/testing';

function session(on) {
  mock.env(on, {});
  const clock = mock.clock(on);
  on('session.id', () => ({ value: 'session-a' }));
  on('session.cwd', () => ({ value: '/work' }));
  on('fs.exists', () => ({ value: true }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  return clock;
}
function http(text, status = 200) {
  return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } };
}
function startStubs(on) {
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('env.set', () => ({ value: undefined }));
  on('command.register', () => ({ value: undefined }));
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__peer__' + e.name } }));
}
const call = { tool: 'Write', file_path: '/work/file.ts', content: 'edited' };
const usage = { model: 'claude-test', input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 };

test('classic adapter merges context and preserves downstream hooks', async ($, on) => {
  session(on);
  const calls = [];
  on('http.fetch', ($, e) => {
    calls.push(e);
    return http(JSON.stringify({ hookSpecificOutput: { additionalContext: 'Peer note' } }));
  });
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['Other hook'] }));
  const answer = await $.classic.UserPromptSubmit({ prompt: 'Change file', session_id: 'session-a' });
  expect(answer.additionalContext).toEqual(['Other hook', 'Peer note']);
  expect(calls[0].init.socketPath).toBeDefined();
  expect(calls[0].init.headers['X-Peer-Adapter']).toBe('mod');
  expect(JSON.parse(calls[0].init.body).session_id).toBe('session-a');
});

test('a broker denial stops an edit before the tool runs', async ($, on) => {
  session(on);
  let ran = 0;
  on('http.fetch', () => http(JSON.stringify({ hookSpecificOutput: {
    permissionDecision: 'deny', permissionDecisionReason: 'another agent owns file.ts',
  } })));
  on('tool.call', () => { ran += 1; return { result: 'edited' }; });
  const answer = await $.tool.call(call);
  expect(ran).toBe(0);
  expect(answer.isError).toBe(true);
  expect(answer.text).toContain('another agent owns file.ts');
});

test('a missing broker preserves legacy hook and permission behavior', async ($, on) => {
  mock.env(on, {}); mock.clock(on);
  on('session.id', () => ({ value: 'session-a' }));
  on('session.cwd', () => ({ value: '/work' }));
  on('fs.exists', () => ({ value: false }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  let fetched = 0;
  on('http.fetch', () => { fetched += 1; return http(''); });
  on('classic.PreToolUse', () => ({ deny: 'legacy policy refuses this' }));
  on('tool.call', () => ({ result: 'should not run' }));
  const answer = await $.tool.call(call);
  expect(fetched).toBe(0);
  expect(answer.text).toContain('legacy policy refuses this');
});

test('a broken broker fails closed for an editing tool', async ($, on) => {
  session(on);
  let ran = 0;
  on('http.fetch', () => http('', 500));
  on('tool.call', () => { ran += 1; return { result: 'edited' }; });
  const answer = await $.tool.call(call);
  expect(ran).toBe(0);
  expect(answer.text).toContain('Peer could not verify this action');
});

test('an unknown response body fails closed instead of skipping the gate', async ($, on) => {
  session(on);
  let ran = 0;
  on('http.fetch', () => http('{broken'));
  on('tool.call', () => { ran += 1; return { result: 'edited' }; });
  const answer = await $.tool.call(call);
  expect(ran).toBe(0);
  expect(answer.isError).toBe(true);
});

test('a clear Peer verdict keeps another hook veto', async ($, on) => {
  session(on);
  on('http.fetch', () => http('{}'));
  on('classic.PreToolUse', () => ({ deny: 'other policy veto' }));
  on('tool.call', () => ({ result: 'should not run' }));
  const answer = await $.tool.call(call);
  expect(answer.text).toContain('other policy veto');
});

test('an unanswered editing intent hits the bounded deadline', async ($, on) => {
  const clock = session(on);
  on('http.fetch', () => new Promise(() => {}));
  let ran = 0;
  on('tool.call', () => { ran += 1; return { result: 'should not run' }; });
  const waiting = $.tool.call(call);
  await clock.settle();
  await clock.advance(8001);
  const answer = await waiting;
  expect(ran).toBe(0);
  expect(answer.text).toContain('Peer could not verify this action');
});

test('PreCompact reaches the broker and preserves downstream execution', async ($, on) => {
  session(on);
  let received;
  on('http.fetch', ($, e) => {
    received = JSON.parse(e.init.body);
    return http(JSON.stringify({ hookSpecificOutput: { additionalContext: 'Not legal on PreCompact' } }));
  });
  on('classic.PreCompact', () => ({}));
  const result = await $.classic.PreCompact({ trigger: 'auto', custom_instructions: '' });
  expect(received.hook_event_name).toBe('PreCompact');
  expect(result.additionalContext).toBe(undefined);
});

test('delivery waits for exact model-input evidence and a provider response', async ($, on) => {
  session(on);
  const requests = [];
  const text = 'Peer version 7: API requires projectId.';
  on('http.fetch', ($, e) => {
    requests.push(e);
    if (e.url.endsWith('/hook')) return http(JSON.stringify({
      hookSpecificOutput: { additionalContext: text }, peerDelivery: { id: 'd7', text, chars: text.length },
    }));
    return http('{}');
  });
  on('classic.UserPromptSubmit', () => ({}));
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text }] }] }));
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage };
  });
  await $.classic.UserPromptSubmit({ prompt: 'Continue' });
  expect(requests.some(e => e.url.endsWith('/delivery'))).toBe(false);
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-test', messageCount: 1 });
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  const receipts = requests.filter(e => e.url.endsWith('/delivery'));
  expect(receipts.length).toBe(1);
  expect(JSON.parse(receipts[0].init.body)).toEqual({ session_id: 'session-a', id: 'd7', evidence: 'model-input', turnId: 'turn-1', index: 0 });
  expect(JSON.parse(requests.find(e => e.url.endsWith('/usage')).init.body).usage).toEqual(usage);
});

test('HTTP success and missing model text never become delivered receipts', async ($, on) => {
  session(on);
  const requests = [];
  on('http.fetch', ($, e) => {
    requests.push(e);
    return http(e.url.endsWith('/hook') ? JSON.stringify({
      hookSpecificOutput: { additionalContext: 'Peer text' }, peerDelivery: { id: 'd8', text: 'Peer text', chars: 9 },
    }) : '{}');
  });
  on('classic.UserPromptSubmit', () => ({}));
  on('session.messages', () => ({ value: [{ role: 'user', content: 'Something else' }] }));
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }; });
  await $.classic.UserPromptSubmit({ prompt: 'Continue' });
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-test', messageCount: 1 });
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  expect(requests.some(e => e.url.endsWith('/delivery'))).toBe(false);
});

test('interrupted requests never acknowledge delivery', async ($, on) => {
  session(on);
  const requests = [];
  on('http.fetch', ($, e) => {
    requests.push(e);
    return http(JSON.stringify({ hookSpecificOutput: { additionalContext: 'Peer text' }, peerDelivery: { id: 'd9', text: 'Peer text' } }));
  });
  on('classic.UserPromptSubmit', () => ({}));
  on('session.messages', () => ({ value: [{ role: 'user', content: 'Peer text' }] }));
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }; });
  await $.classic.UserPromptSubmit({ prompt: 'Continue' });
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-test', messageCount: 1 });
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  expect(requests.length).toBe(1);
});

test('native peer_context sends bounded arguments directly to the broker', async ($, on) => {
  session(on);
  let request;
  on('http.fetch', ($, e) => { request = e; return http('Shared context v7'); });
  const result = await $.tool.call({ tool: 'mcp__peer__peer_context', work: 'KRK-812' });
  expect(result.result).toBe('Shared context v7');
  expect(request.url).toBe('http://peer/cli/context');
  expect(request.init.body).toBe('KRK-812\0');
});

test('headless SDK sessions do not create hidden model turns for a wake', async ($, on) => {
  const clock = session(on); startStubs(on);
  const paths = [];
  on('http.fetch', ($, e) => { paths.push(e.url); return http('{}'); });
  on('classic.Stop', () => ({}));
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.classic.Stop({ stop_hook_active: false });
  await clock.settle();
  expect(paths.some(path => path.endsWith('/hook/wait'))).toBe(false);
});

test('a new turn cancels a late long-poll wake', async ($, on) => {
  const clock = session(on); startStubs(on);
  let release;
  let prompts = 0;
  on('http.fetch', ($, e) => e.url.endsWith('/hook/wait')
    ? new Promise(resolve => { release = resolve; }) : http('{}'));
  on('classic.Stop', () => ({}));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('prompt.submit', ($, e) => { prompts += 1; return { text: e.text }; });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.classic.Stop({ stop_hook_active: false });
  await clock.settle();
  expect(release).toBeDefined();
  await $.turn.start({ text: 'new user prompt', turnId: 'new-turn' });
  release(http('a late coordination message'));
  await clock.settle();
  expect(prompts).toBe(0);
});

test('an idle interactive session wakes once for a broker message', async ($, on) => {
  const clock = session(on); startStubs(on);
  const prompts = [];
  on('http.fetch', ($, e) => http(e.url.endsWith('/hook/wait') ? 'Peer: one coordination message' : '{}'));
  on('classic.Stop', () => ({}));
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text }; });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.classic.Stop({ stop_hook_active: false });
  await clock.settle();
  expect(prompts).toEqual(['Peer: one coordination message']);
});

test('session end cancels a late long-poll wake', async ($, on) => {
  const clock = session(on); startStubs(on);
  let release;
  let prompts = 0;
  on('http.fetch', ($, e) => e.url.endsWith('/hook/wait')
    ? new Promise(resolve => { release = resolve; }) : http('{}'));
  on('classic.Stop', () => ({}));
  on('classic.SessionEnd', () => ({}));
  on('prompt.submit', ($, e) => { prompts += 1; return { text: e.text }; });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.classic.Stop({ stop_hook_active: false });
  await clock.settle();
  expect(release).toBeDefined();
  await $.classic.SessionEnd({ reason: 'exit' });
  release(http('a late coordination message'));
  await clock.settle();
  expect(prompts).toBe(0);
});

test('/peer falls back to human-visible text without adding model context', async ($, on) => {
  session(on);
  on('session.surfaces', () => ({ value: [] }));
  on('http.fetch', () => http('Team work: KRK-812 · Agent A'));
  const answer = await $.command.run({ command: 'peer', args: '' });
  expect(answer.text).toBe('Team work: KRK-812 · Agent A');
  expect(answer.context).toBeUndefined();
});

test('/peer draws its native pane on terminal and desktop', async ($, on) => {
  session(on);
  on('session.surfaces', () => ({ value: ['terminal', 'desktop'] }));
  on('http.fetch', () => http('Team work: KRK-812 · Agent A'));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  const answer = await $.command.run({ command: 'peer', args: '' });
  expect(answer.context).toBeUndefined();
  for (const surface of ['terminal', 'desktop']) {
    const ui = await $.ui.mount({ plugin: 'peer', surface, component: 'Pane', requestId: 'peer-board', props: { title: 'Peer', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } });
    expect(await ui.find({ type: 'Text', text: /KRK-812/ })).toBeDefined();
    expect(await ui.find({ key: 'peer-refresh' })).toBeDefined();
    await ui.unmount();
  }
});
`;
