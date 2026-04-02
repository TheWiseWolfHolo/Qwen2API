const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVisionSize,
  parseStreamPayloads,
  extractVisionSignal,
  buildModernVisionRequestBody,
} = require('../src/utils/vision-response');

test('normalizeVisionSize prefers explicit supported size', () => {
  assert.equal(normalizeVisionSize({ explicitSize: '4:3', promptText: 'hello' }), '4:3');
});

test('normalizeVisionSize falls back to prompt marker', () => {
  assert.equal(normalizeVisionSize({ explicitSize: undefined, promptText: 'draw cat @9:16 now' }), '9:16');
});

test('normalizeVisionSize defaults to 16:9', () => {
  assert.equal(normalizeVisionSize({ explicitSize: undefined, promptText: 'draw cat' }), '16:9');
});

test('parseStreamPayloads parses SSE and plain json lines', () => {
  const payloads = parseStreamPayloads([
    'data: {"response.created":{"chat_id":"abc"}}\n\n',
    '{"success":true,"data":{"messages":[{"extra":{"wanx":{"task_id":"task-1"}}}]}}\n\n'
  ].join(''));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0]['response.created'].chat_id, 'abc');
  assert.equal(payloads[1].data.messages[0].extra.wanx.task_id, 'task-1');
});

test('extractVisionSignal returns image url when upstream emits image_gen content', () => {
  const signal = extractVisionSignal({
    choices: [{ delta: { content: 'https://cdn.example.com/image.png', phase: 'image_gen' } }]
  });
  assert.deepEqual(signal, { type: 'media_url', url: 'https://cdn.example.com/image.png', phase: 'image_gen' });
});

test('extractVisionSignal returns task id for async wanx payload', () => {
  const signal = extractVisionSignal({
    success: true,
    data: {
      messages: [{ extra: { wanx: { task_id: 'task-123' } } }]
    }
  });
  assert.deepEqual(signal, { type: 'task_id', taskId: 'task-123' });
});

test('extractVisionSignal returns upstream error details', () => {
  const signal = extractVisionSignal({
    success: false,
    data: { code: 'Bad_Request', details: 'Internal error...' }
  });
  assert.deepEqual(signal, { type: 'error', code: 'Bad_Request', message: 'Internal error...' });
});

test('buildModernVisionRequestBody matches qwen web request shape', () => {
  const body = buildModernVisionRequestBody({
    chatId: 'chat-1',
    model: 'qwen3.5-plus',
    prompt: 'draw cat',
    chatType: 't2i',
    size: '16:9'
  });

  assert.equal(body.stream, true);
  assert.equal(body.version, '2.1');
  assert.equal(body.incremental_output, true);
  assert.equal(body.chat_id, 'chat-1');
  assert.equal(body.chat_mode, 'local');
  assert.equal(body.model, 'qwen3.5-plus');
  assert.equal(body.parent_id, null);
  assert.equal(body.size, '16:9');
  assert.equal(body.messages[0].chat_type, 't2i');
  assert.equal(body.messages[0].content, 'draw cat');
});

