const axios = require('axios')
const { logger } = require('../utils/logger.js')
const { setResponseHeaders } = require('./chat.js')
const accountManager = require('../utils/account.js')
const { sleep } = require('../utils/tools.js')
const { generateChatID } = require('../utils/request.js')
const { getSsxmodItna, getSsxmodItna2 } = require('../utils/ssxmod-manager')
const { getProxyAgent, getChatBaseUrl } = require('../utils/proxy-helper')
const {
    buildModernVisionRequestBody,
    normalizeVisionSize,
    parseStreamPayloads,
    extractVisionSignal,
} = require('../utils/vision-response')

class VisionRequestError extends Error {
    constructor(message, code = 'VISION_UPSTREAM_ERROR', statusCode = 502) {
        super(message)
        this.name = 'VisionRequestError'
        this.code = code
        this.statusCode = statusCode
    }
}

const buildHeaders = (token, chatBaseUrl) => ({
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    'Connection': 'keep-alive',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Content-Type': 'application/json',
    'Timezone': 'Mon Dec 08 2025 17:28:55 GMT+0800',
    'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'source': 'web',
    'Version': '0.1.13',
    'bx-v': '2.5.31',
    'Origin': chatBaseUrl,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': `${chatBaseUrl}/c/guest`,
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cookie': `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
    'X-Accel-Buffering': 'no',
})

const buildAxiosConfig = (token, chatBaseUrl, responseType = 'stream', timeout = 1000 * 60 * 5) => {
    const proxyAgent = getProxyAgent()
    const config = {
        headers: buildHeaders(token, chatBaseUrl),
        responseType,
        timeout,
    }

    if (proxyAgent) {
        config.httpsAgent = proxyAgent
        config.proxy = false
    }

    return config
}

const buildOpenAIResponse = (model, content) => ({
    created: new Date().getTime(),
    model,
    choices: [
        {
            index: 0,
            message: {
                role: 'assistant',
                content,
            },
        },
    ],
})

const sendOpenAIResponse = (res, model, content, stream) => {
    setResponseHeaders(res, stream)
    const returnBody = buildOpenAIResponse(model, content)

    if (stream) {
        res.write(`data: ${JSON.stringify(returnBody)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
    } else {
        res.json(returnBody)
    }
}

const formatVisionContent = (chatType, contentUrl) => {
    if (!contentUrl || typeof contentUrl !== 'string') {
        throw new VisionRequestError('上游没有返回有效的媒体地址', 'VISION_EMPTY_MEDIA_URL', 502)
    }

    if (chatType === 't2v') {
        return `\n<video controls = "controls">\n${contentUrl}\n</video>\n\n[Download Video](${contentUrl})\n`
    }

    return `![image](${contentUrl})`
}

const getPromptText = (input) => {
    if (typeof input === 'string') {
        return input
    }

    if (Array.isArray(input)) {
        return input
            .filter(item => item.type === 'text')
            .map(item => item.text || '')
            .join('')
    }

    return ''
}

const extractQuotedImages = (content) => {
    if (typeof content !== 'string') {
        return []
    }

    const matches = [...content.matchAll(/!\[image\]\((.*?)\)/g)]
    return matches.map(match => match[1]).filter(Boolean)
}

const normalizeVisionInput = (messages, chatType) => {
    const safeMessages = Array.isArray(messages) ? messages : []
    const latestMessage = safeMessages[safeMessages.length - 1]
    const prompt = getPromptText(latestMessage?.content).trim()

    if (!prompt) {
        throw new VisionRequestError('图片/视频请求缺少有效提示词', 'VISION_EMPTY_PROMPT', 400)
    }

    const files = []

    if (chatType === 'image_edit') {
        for (const message of safeMessages) {
            if (message?.role === 'assistant') {
                for (const url of extractQuotedImages(message.content)) {
                    files.push({ type: 'image', url })
                }
            }

            if (Array.isArray(message?.content)) {
                for (const item of message.content) {
                    if (item?.type === 'image' && item.image) {
                        files.push({ type: 'image', url: item.image })
                    }
                }
            }
        }
    }

    return {
        prompt,
        files,
    }
}

const readVisionStreamUntilSignal = (stream, { timeoutMs = 120000 } = {}) => new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let settled = false

    const finish = (fn, value) => {
        if (settled) {
            return
        }

        settled = true
        clearTimeout(timer)
        cleanup()
        fn(value)
    }

    const timer = setTimeout(() => {
        finish(reject, new VisionRequestError('等待上游图片/视频结果超时', 'VISION_WAIT_TIMEOUT', 504))
    }, timeoutMs)

    const handleFrame = (frame) => {
        const payloads = parseStreamPayloads(frame)
        for (const payload of payloads) {
            const signal = extractVisionSignal(payload)
            if (signal.type === 'ignore') {
                continue
            }

            if (signal.type === 'error') {
                finish(reject, new VisionRequestError(signal.message, signal.code || 'VISION_UPSTREAM_ERROR', 502))
                return
            }

            finish(resolve, signal)
            return
        }
    }

    const onData = (chunk) => {
        buffer += decoder.decode(chunk, { stream: true })

        const frames = buffer.split(/\n\n/)
        if (frames.length > 1) {
            buffer = frames.pop() || ''
            for (const frame of frames) {
                handleFrame(frame)
                if (settled) {
                    return
                }
            }
        } else {
            const trimmed = buffer.trim()
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                handleFrame(trimmed)
                if (settled) {
                    return
                }
                buffer = ''
            }
        }
    }

    const onError = (error) => {
        finish(reject, new VisionRequestError(error?.message || '读取上游图片/视频流失败', 'VISION_STREAM_ERROR', 502))
    }

    const onEnd = () => {
        if (buffer.trim()) {
            handleFrame(buffer)
            if (settled) {
                return
            }
        }

        finish(reject, new VisionRequestError('上游已结束，但未返回可用的图片/视频结果', 'VISION_EMPTY_RESULT', 502))
    }

    const cleanup = () => {
        stream.off('data', onData)
        stream.off('error', onError)
        stream.off('end', onEnd)
        stream.off('close', onEnd)
    }

    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
    stream.once('close', onEnd)
})

const getVisionTaskStatus = async (taskId, token) => {
    const chatBaseUrl = getChatBaseUrl()
    const requestConfig = buildAxiosConfig(token, chatBaseUrl, 'json', 60000)
    const response = await axios.get(`${chatBaseUrl}/api/v1/tasks/status/${taskId}`, requestConfig)

    return {
        taskStatus: response?.data?.task_status,
        content: response?.data?.content || '',
        raw: response?.data,
    }
}

const pollVisionTaskContent = async (taskId, token, chatType) => {
    const maxAttempts = chatType === 't2v' ? 60 : 36
    const delayMs = chatType === 't2v' ? 10000 : 5000

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const status = await getVisionTaskStatus(taskId, token)

            if (status.taskStatus === 'success' && status.content) {
                return status.content
            }

            if (['failed', 'error', 'canceled'].includes(status.taskStatus)) {
                throw new VisionRequestError(`上游任务失败: ${status.taskStatus}`, 'VISION_TASK_FAILED', 502)
            }
        } catch (error) {
            if (error instanceof VisionRequestError) {
                throw error
            }

            logger.warn(`轮询任务 ${taskId} 失败，第 ${attempt + 1} 次重试`, 'CHAT', error?.message || error)
        }

        await sleep(delayMs)
    }

    throw new VisionRequestError('等待上游异步任务完成超时', 'VISION_TASK_TIMEOUT', 504)
}

const requestImageGeneration = async ({ token, chatId, model, prompt, size }) => {
    const chatBaseUrl = getChatBaseUrl()
    const requestBody = buildModernVisionRequestBody({
        chatId,
        model,
        prompt,
        chatType: 't2i',
        size,
    })

    const requestConfig = buildAxiosConfig(token, chatBaseUrl, 'stream', 1000 * 60 * 5)
    const response = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=${chatId}`, requestBody, requestConfig)
    const signal = await readVisionStreamUntilSignal(response.data, { timeoutMs: 1000 * 60 * 2 })

    if (signal.type === 'media_url') {
        return signal.url
    }

    if (signal.type === 'task_id') {
        return await pollVisionTaskContent(signal.taskId, token, 't2i')
    }

    throw new VisionRequestError('图片生成没有返回有效结果', 'VISION_IMAGE_EMPTY', 502)
}

const requestVideoGeneration = async ({ token, chatId, model, prompt, size }) => {
    const chatBaseUrl = getChatBaseUrl()
    const requestBody = {
        stream: false,
        chat_id: chatId,
        model,
        size,
        messages: [
            {
                role: 'user',
                content: prompt,
                files: [],
                chat_type: 't2v',
                feature_config: {
                    output_schema: 'phase',
                },
            },
        ],
    }

    const requestConfig = buildAxiosConfig(token, chatBaseUrl, 'stream', 1000 * 60 * 5)
    const response = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=${chatId}`, requestBody, requestConfig)
    const signal = await readVisionStreamUntilSignal(response.data, { timeoutMs: 45000 })

    if (signal.type === 'task_id') {
        return await pollVisionTaskContent(signal.taskId, token, 't2v')
    }

    if (signal.type === 'media_url') {
        return signal.url
    }

    throw new VisionRequestError('视频生成没有返回有效结果', 'VISION_VIDEO_EMPTY', 502)
}

const requestImageEdit = async ({ token, chatId, model, prompt, files, size }) => {
    const chatBaseUrl = getChatBaseUrl()
    const requestBody = buildModernVisionRequestBody({
        chatId,
        model,
        prompt,
        chatType: files.length > 0 ? 'image_edit' : 't2i',
        size,
        files,
    })

    const requestConfig = buildAxiosConfig(token, chatBaseUrl, 'stream', 1000 * 60 * 5)
    const response = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=${chatId}`, requestBody, requestConfig)
    const signal = await readVisionStreamUntilSignal(response.data, { timeoutMs: 1000 * 60 * 2 })

    if (signal.type === 'media_url') {
        return signal.url
    }

    if (signal.type === 'task_id') {
        return await pollVisionTaskContent(signal.taskId, token, 't2i')
    }

    throw new VisionRequestError('图片编辑没有返回有效结果', 'VISION_IMAGE_EDIT_EMPTY', 502)
}

/**
 * 主要的聊天完成处理函数
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleImageVideoCompletion = async (req, res) => {
    const { model, messages, size, chat_type } = req.body
    const token = accountManager.getAccountToken()

    if (!token) {
        res.status(500).json({ error: '无法获取有效的上游账号令牌' })
        return
    }

    try {
        const { prompt, files } = normalizeVisionInput(messages, chat_type)
        const normalizedSize = normalizeVisionSize({ explicitSize: size, promptText: prompt })
        const chatId = await generateChatID(token, model)

        if (!chatId) {
            throw new VisionRequestError('生成 chat_id 失败', 'VISION_CHAT_ID_ERROR', 502)
        }

        logger.info(`发送视觉请求: ${chat_type} | size=${normalizedSize}`, 'CHAT')
        logger.info(`使用提示: ${prompt}`, 'CHAT')

        let contentUrl = null
        if (chat_type === 't2v') {
            contentUrl = await requestVideoGeneration({ token, chatId, model, prompt, size: normalizedSize })
        } else if (chat_type === 'image_edit') {
            contentUrl = await requestImageEdit({ token, chatId, model, prompt, files, size: normalizedSize })
        } else {
            contentUrl = await requestImageGeneration({ token, chatId, model, prompt, size: normalizedSize })
        }

        const content = formatVisionContent(chat_type, contentUrl)
        sendOpenAIResponse(res, model, content, req.body.stream)
    } catch (error) {
        const statusCode = error instanceof VisionRequestError ? error.statusCode : 500
        const code = error instanceof VisionRequestError ? error.code : 'VISION_UNKNOWN_ERROR'
        const message = error?.message || '服务错误，请稍后再试'

        logger.error(`视觉请求失败 [${code}] ${message}`, 'CHAT', '', error)
        res.status(statusCode).json({ error: message, code })
    }
}

module.exports = {
    handleImageVideoCompletion,
}
