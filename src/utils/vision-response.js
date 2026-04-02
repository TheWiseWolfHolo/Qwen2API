const SUPPORTED_VISION_SIZES = new Set(['1:1', '4:3', '3:4', '16:9', '9:16']);
const DEFAULT_VISION_SIZE = '16:9';

const normalizeVisionSize = ({ explicitSize, promptText }) => {
  if (typeof explicitSize === 'string' && SUPPORTED_VISION_SIZES.has(explicitSize)) {
    return explicitSize;
  }

  if (typeof promptText === 'string') {
    const match = promptText.match(/@(1:1|4:3|3:4|16:9|9:16)\b/);
    if (match) {
      return match[1];
    }
  }

  return DEFAULT_VISION_SIZE;
};

const buildModernVisionRequestBody = ({
  chatId,
  model,
  prompt,
  chatType,
  size,
  files = [],
  chatMode = 'local',
}) => ({
  stream: true,
  version: '2.1',
  incremental_output: true,
  chat_id: chatId,
  chat_mode: chatMode,
  model,
  parent_id: null,
  messages: [
    {
      role: 'user',
      content: prompt,
      files,
      chat_type: chatType,
      feature_config: {
        output_schema: 'phase',
        thinking_enabled: false,
        research_mode: 'normal',
        auto_search: false,
      },
      extra: {},
    },
  ],
  timestamp: Math.floor(Date.now() / 1000),
  size,
});

const parseStreamPayloads = (chunkText) => {
  if (!chunkText || typeof chunkText !== 'string') {
    return [];
  }

  const payloads = [];
  const lines = chunkText
    .split(/\n\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    const normalized = rawLine.startsWith('data:')
      ? rawLine.replace(/^data:\s*/, '').trim()
      : rawLine;

    if (!normalized || normalized === '[DONE]') {
      continue;
    }

    try {
      payloads.push(JSON.parse(normalized));
    } catch {
      // Ignore partial / non-JSON chunks and let caller continue buffering.
    }
  }

  return payloads;
};

const extractVisionSignal = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return { type: 'ignore' };
  }

  if (payload.success === false) {
    return {
      type: 'error',
      code: payload?.data?.code || 'UpstreamError',
      message: payload?.data?.details || payload?.data?.content || payload?.message || 'Upstream request failed',
    };
  }

  const taskId =
    payload?.data?.messages?.at?.(-1)?.extra?.wanx?.task_id ||
    payload?.data?.messages?.[payload?.data?.messages?.length - 1]?.extra?.wanx?.task_id ||
    payload?.choices?.[0]?.delta?.extra?.wanx?.task_id ||
    payload?.extra?.wanx?.task_id ||
    payload?.response?.message?.extra?.wanx?.task_id;

  if (taskId) {
    return {
      type: 'task_id',
      taskId,
    };
  }

  const delta = payload?.choices?.[0]?.delta;
  if (typeof delta?.content === 'string') {
    const content = delta.content.trim();
    if (/^https?:\/\//i.test(content)) {
      return {
        type: 'media_url',
        url: content,
        phase: delta.phase || null,
      };
    }
  }

  return { type: 'ignore' };
};

module.exports = {
  DEFAULT_VISION_SIZE,
  SUPPORTED_VISION_SIZES,
  normalizeVisionSize,
  buildModernVisionRequestBody,
  parseStreamPayloads,
  extractVisionSignal,
};
