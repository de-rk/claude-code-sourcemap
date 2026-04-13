#!/usr/bin/env node
/**
 * Anthropic → OpenAI-compatible proxy
 *
 * Translates Anthropic Messages API requests to OpenAI /chat/completions format,
 * then translates the response back to Anthropic format.
 *
 * Usage:
 *   OPENAI_BASE_URL=https://api.deepseek.com/v1 \
 *   OPENAI_API_KEY=sk-xxx \
 *   OPENAI_MODEL=deepseek-chat \
 *   node openai-proxy.js [--port 19999]
 *
 * Then run Claude Code pointing at this proxy:
 *   ANTHROPIC_BASE_URL=http://localhost:19999 \
 *   ANTHROPIC_API_KEY=dummy \
 *   node package/cli.js
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

const PORT = parseInt(process.env.PROXY_PORT || '19999', 10)
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'

// ─── Anthropic → OpenAI conversion ──────────────────────────────────────────

function convertContentToOpenAI(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)

  const parts = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      if (block.source?.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        })
      } else if (block.source?.type === 'url') {
        parts.push({ type: 'image_url', image_url: { url: block.source.url } })
      }
    } else if (block.type === 'tool_use') {
      // tool_use blocks in user messages are rare; skip
    } else if (block.type === 'tool_result') {
      // handled separately in message conversion
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // skip thinking blocks — not supported by OpenAI
    }
  }

  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts.length > 0 ? parts : ''
}

function convertMessagesToOpenAI(messages) {
  const result = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      // Check if content has tool_result blocks
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(b => b.type === 'tool_result')
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result')

        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: Array.isArray(tr.content)
              ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : (tr.content || ''),
          })
        }

        if (otherBlocks.length > 0) {
          const converted = convertContentToOpenAI(otherBlocks)
          if (converted !== '' && !(Array.isArray(converted) && converted.length === 0)) {
            result.push({ role: 'user', content: converted })
          }
        }
      } else {
        result.push({ role: 'user', content: convertContentToOpenAI(msg.content) })
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(
          b => b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking'
        )
        const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use')

        const textContent = textBlocks
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n') || null

        const toolCalls = toolUseBlocks.map(b => ({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input),
          },
        }))

        const oaiMsg = { role: 'assistant', content: textContent }
        if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls
        result.push(oaiMsg)
      } else {
        result.push({ role: 'assistant', content: convertContentToOpenAI(msg.content) })
      }
    }
  }
  return result
}

function convertToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function buildOpenAIRequest(anthropicBody, model) {
  model = model || OPENAI_MODEL
  const messages = []

  // System prompt
  if (anthropicBody.system) {
    const systemText = Array.isArray(anthropicBody.system)
      ? anthropicBody.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : anthropicBody.system
    if (systemText) messages.push({ role: 'system', content: systemText })
  }

  // Conversation messages
  messages.push(...convertMessagesToOpenAI(anthropicBody.messages || []))

  const req = {
    model: model,
    messages,
    max_tokens: anthropicBody.max_tokens,
    stream: anthropicBody.stream === true,
  }

  if (anthropicBody.temperature !== undefined) req.temperature = anthropicBody.temperature
  if (anthropicBody.stop_sequences?.length) req.stop = anthropicBody.stop_sequences

  const tools = convertToolsToOpenAI(anthropicBody.tools)
  if (tools) {
    req.tools = tools
    if (anthropicBody.tool_choice) {
      if (anthropicBody.tool_choice.type === 'auto') req.tool_choice = 'auto'
      else if (anthropicBody.tool_choice.type === 'any') req.tool_choice = 'required'
      else if (anthropicBody.tool_choice.type === 'tool') {
        req.tool_choice = { type: 'function', function: { name: anthropicBody.tool_choice.name } }
      }
    }
  }

  return req
}

// ─── OpenAI → Anthropic conversion ──────────────────────────────────────────

function convertOpenAIChoiceToAnthropic(choice) {
  const content = []
  const msg = choice.message || choice.delta || {}

  if (msg.content) {
    content.push({ type: 'text', text: msg.content })
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: (() => {
          try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} }
        })(),
      })
    }
  }

  return content
}

function openAIStopToAnthropic(finishReason) {
  if (finishReason === 'stop') return 'end_turn'
  if (finishReason === 'tool_calls') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  return 'end_turn'
}

function buildAnthropicResponse(oaiResponse, requestId) {
  const choice = oaiResponse.choices?.[0]
  const content = choice ? convertOpenAIChoiceToAnthropic(choice) : []
  const usage = oaiResponse.usage || {}

  return {
    id: oaiResponse.id || `msg_${requestId}`,
    type: 'message',
    role: 'assistant',
    content,
    model: oaiResponse.model || OPENAI_MODEL,
    stop_reason: openAIStopToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  }
}

// ─── Streaming conversion ────────────────────────────────────────────────────

function* convertSSEChunk(line, state) {
  if (!line.startsWith('data: ')) return
  const data = line.slice(6).trim()
  if (data === '[DONE]') {
    yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`
    return
  }

  let chunk
  try { chunk = JSON.parse(data) } catch { return }

  const choice = chunk.choices?.[0]
  if (!choice) return
  const delta = choice.delta || {}

  // First chunk: emit message_start
  if (!state.started) {
    state.started = true
    state.inputTokens = chunk.usage?.prompt_tokens || 0
    yield `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: chunk.id || 'msg_proxy',
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model || OPENAI_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    })}\n\n`
  }

  // Text delta
  if (delta.content) {
    if (!state.textBlockStarted) {
      state.textBlockStarted = true
      state.textBlockIdx = state.blockIdx++
      yield `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: state.textBlockIdx,
        content_block: { type: 'text', text: '' },
      })}\n\n`
    }
    yield `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: state.textBlockIdx,
      delta: { type: 'text_delta', text: delta.content },
    })}\n\n`
  }

  // Tool call deltas
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const tcIdx = tc.index ?? 0
      if (!state.toolBlocks) state.toolBlocks = {}
      if (!state.toolBlocks[tcIdx]) {
        state.toolBlocks[tcIdx] = { blockIdx: state.blockIdx++, id: tc.id, name: tc.function?.name || '', args: '' }
        yield `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: state.toolBlocks[tcIdx].blockIdx,
          content_block: { type: 'tool_use', id: tc.id || `tool_${tcIdx}`, name: tc.function?.name || '', input: {} },
        })}\n\n`
      }
      const tb = state.toolBlocks[tcIdx]
      if (tc.function?.name) tb.name = tc.function.name
      if (tc.function?.arguments) {
        tb.args += tc.function.arguments
        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: tb.blockIdx,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        })}\n\n`
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    // Close open blocks
    if (state.textBlockStarted) {
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: state.textBlockIdx })}\n\n`
    }
    if (state.toolBlocks) {
      for (const tb of Object.values(state.toolBlocks)) {
        yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tb.blockIdx })}\n\n`
      }
    }
    const outputTokens = chunk.usage?.completion_tokens || 0
    yield `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: openAIStopToAnthropic(choice.finish_reason), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })}\n\n`
    yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`
  }
}

// ─── HTTP proxy ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function forwardToOpenAI(oaiBody, baseUrl, apiKey) {
  baseUrl = baseUrl || OPENAI_BASE_URL
  apiKey = apiKey || OPENAI_API_KEY
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/chat/completions`)
    const body = JSON.stringify(oaiBody)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'anthropic-openai-proxy/1.0',
      },
    }

    const req = lib.request(options, resolve)
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function createServer() {
  return http.createServer(async (req, res) => {
    const baseUrl = process.env.OPENAI_BASE_URL || OPENAI_BASE_URL
    const apiKey = process.env.OPENAI_API_KEY || OPENAI_API_KEY
    const model = process.env.OPENAI_MODEL || OPENAI_MODEL

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', target: baseUrl, model }))
      return
    }

    // Only handle messages endpoint (Anthropic SDK calls /v1/messages)
    if (!req.url?.includes('/messages')) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    let rawBody
    try {
      rawBody = await readBody(req)
    } catch (e) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Failed to read body' }))
      return
    }

    let anthropicBody
    try {
      anthropicBody = JSON.parse(rawBody)
    } catch (e) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const isStream = anthropicBody.stream === true
    const oaiBody = buildOpenAIRequest(anthropicBody, model)

    console.error(`[proxy] → ${model} stream=${isStream} msgs=${anthropicBody.messages?.length}`)

    let oaiRes
    try {
      oaiRes = await forwardToOpenAI(oaiBody, baseUrl, apiKey)
    } catch (e) {
      console.error('[proxy] upstream error:', e.message)
      res.writeHead(502)
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }))
      return
    }

    if (oaiRes.statusCode !== 200) {
      const errBody = await new Promise(r => {
        const chunks = []
        oaiRes.on('data', c => chunks.push(c))
        oaiRes.on('end', () => r(Buffer.concat(chunks).toString()))
      })
      console.error(`[proxy] upstream ${oaiRes.statusCode}:`, errBody.slice(0, 200))
      res.writeHead(oaiRes.statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { type: 'api_error', message: `Upstream ${oaiRes.statusCode}: ${errBody}` },
      }))
      return
    }

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      const state = { started: false, blockIdx: 0, textBlockStarted: false, textBlockIdx: 0 }
      let buf = ''

      oaiRes.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          for (const sseChunk of convertSSEChunk(line.trim(), state)) {
            res.write(sseChunk)
          }
        }
      })

      oaiRes.on('end', () => {
        if (buf.trim()) {
          for (const sseChunk of convertSSEChunk(buf.trim(), state)) {
            res.write(sseChunk)
          }
        }
        res.end()
      })

      oaiRes.on('error', e => {
        console.error('[proxy] stream error:', e.message)
        res.end()
      })
    } else {
      const chunks = []
      oaiRes.on('data', c => chunks.push(c))
      oaiRes.on('end', () => {
        let oaiResponse
        try {
          oaiResponse = JSON.parse(Buffer.concat(chunks).toString())
        } catch (e) {
          res.writeHead(502)
          res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'Invalid upstream JSON' } }))
          return
        }
        const anthropicResponse = buildAnthropicResponse(oaiResponse, Date.now().toString(36))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(anthropicResponse))
      })
    }
  })
}

// ─── Export for embedding in Claude Code ────────────────────────────────────

export async function startOpenAIProxy() {
  const port = parseInt(process.env.PROXY_PORT || '19999', 10)
  const baseUrl = process.env.OPENAI_BASE_URL || OPENAI_BASE_URL
  const model = process.env.OPENAI_MODEL || OPENAI_MODEL
  const server = createServer()
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  console.error(`[proxy] Anthropic→OpenAI proxy on :${port} → ${baseUrl} (${model})`)
  return port
}

// ─── Standalone mode ─────────────────────────────────────────────────────────

// Run directly: node openai-proxy.js
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const server = createServer()
  server.listen(PORT, '127.0.0.1', () => {
    console.error(`[proxy] Anthropic→OpenAI proxy listening on http://127.0.0.1:${PORT}`)
    console.error(`[proxy] Forwarding to: ${OPENAI_BASE_URL}`)
    console.error(`[proxy] Model: ${OPENAI_MODEL}`)
    console.error()
    console.error('Run Claude Code with:')
    console.error(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} ANTHROPIC_API_KEY=dummy node package/cli.js`)
  })
}
