import { Router } from 'express'
import { rateLimiter } from '../utils/rateLimiter.js'

const router = Router()

function detectLanguage(text) {
  const cjkCount = (text.match(/[一-鿿㐀-䶿]/g) || []).length
  const totalChars = text.replace(/\s/g, '').length || 1
  return cjkCount / totalChars > 0.3 ? 'Chinese' : 'English'
}

function estimateTokens(text, lang) {
  const charsPerToken = lang === 'Chinese' ? 1.5 : 4
  return Math.ceil(text.length / charsPerToken)
}

function splitTextIntoChunks(text, maxTokensPerChunk = 3000) {
  const lang = detectLanguage(text)
  const charsPerToken = lang === 'Chinese' ? 1.5 : 4
  const maxChunkChars = Math.floor(maxTokensPerChunk * charsPerToken)

  const paragraphs = text.split('\n\n')
  const chunks = []

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChunkChars) {
      chunks.push(paragraph)
    } else {
      const sentences = paragraph.split(/(?<=[.!?。！？])\s*/)
      let temp = ''
      for (const sentence of sentences) {
        if (temp.length + sentence.length <= maxChunkChars) {
          temp += sentence
        } else {
          if (temp) chunks.push(temp)
          temp = sentence
        }
      }
      if (temp) chunks.push(temp)
    }
  }

  const merged = []
  let current = ''
  for (const chunk of chunks) {
    if (current.length + chunk.length + 2 <= maxChunkChars) {
      current += (current ? '\n\n' : '') + chunk
    } else {
      if (current) merged.push(current)
      current = chunk
    }
  }
  if (current) merged.push(current)

  return merged
}

async function callTranslationApi(text, targetLang) {
  const response = await fetch(process.env.API_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'Hunyuan-MT-7B',
      messages: [
        {
          role: 'system',
          content: '你是一个专业翻译引擎。你的唯一任务是逐句翻译文档，必须翻译每一句话，不允许总结、概括、省略、合并或改写任何内容。保持原文格式标记不变。直接输出翻译结果，不要添加任何解释或说明。'
        },
        {
          role: 'user',
          content: `将以下文档逐句翻译为${targetLang}，必须翻译每一句话，不允许总结或省略任何内容：\n\n${text}`
        }
      ],
      max_tokens: 4096,
      temperature: 0
    })
  })

  if (!response.ok) {
    const responseText = await response.text()
    let errorMsg = `HTTP ${response.status}`
    try {
      const err = JSON.parse(responseText)
      errorMsg = err.error?.message || errorMsg
    } catch {
      const stripped = responseText.replace(/<[^>]*>/g, '').trim()
      errorMsg = stripped || errorMsg
    }
    throw new Error(errorMsg)
  }

  const data = await response.json()
  const result = data.choices?.[0]?.message?.content
  if (!result) throw new Error('Translation returned empty')
  return result
}

function isContextLengthError(message) {
  const hints = ['context', 'length', 'too long', 'token', 'maximum', 'exceed', 'truncat']
  return hints.some(hint => message.toLowerCase().includes(hint))
}

router.post('/', async (req, res) => {
  try {
    const { text, targetLang } = req.body

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' })
    }
    if (!targetLang || !['English', 'Chinese'].includes(targetLang)) {
      return res.status(400).json({ error: 'targetLang must be "English" or "Chinese"' })
    }

    const sourceLang = detectLanguage(text)
    const estimatedTokens = estimateTokens(text, sourceLang)

    try {
      await rateLimiter.wait()
      const result = await callTranslationApi(text, targetLang)
      console.log(`[translate] Full text OK — ${estimatedTokens} estimated tokens, ${text.length} chars`)
      return res.json({ translatedText: result, chunked: false })
    } catch (err) {
      const isLengthErr = isContextLengthError(err.message)
      // Worth chunking if text is long enough to split into at least 2 chunks (~1500 chars each)
      const worthChunking = text.length > (sourceLang === 'Chinese' ? 800 : 2000)

      console.warn(`[translate] Full text failed (${err.message}), isLengthErr=${isLengthErr}, worthChunking=${worthChunking}, chars=${text.length}`)

      if (!isLengthErr && !worthChunking) {
        throw err
      }

      const chunks = splitTextIntoChunks(text)
      console.log(`[translate] Split into ${chunks.length} chunks`)
      if (chunks.length <= 1) throw err

      let successCount = 0
      let failCount = 0
      const results = []
      for (let i = 0; i < chunks.length; i++) {
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            await rateLimiter.wait()
            const result = await callTranslationApi(chunks[i], targetLang)
            results.push(result)
            successCount++
            console.log(`[translate] Chunk ${i + 1}/${chunks.length} OK (${chunks[i].length} chars)`)
            break
          } catch (chunkErr) {
            if (attempt === 2) {
              results.push(`[翻译失败: ${chunkErr.message}]`)
              failCount++
              console.error(`[translate] Chunk ${i + 1}/${chunks.length} FAILED: ${chunkErr.message}`)
              break
            }
            const isRateLimit = chunkErr.message.includes('429') || chunkErr.message.includes('rate')
            const delay = isRateLimit ? 15000 : Math.min(Math.pow(2, attempt) * 2000, 8000)
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }

      return res.json({
        translatedText: results.join('\n\n'),
        chunked: true,
        chunksTotal: chunks.length,
        successCount,
        failCount
      })
    }
  } catch (err) {
    console.error(`[translate] Fatal error:`, err.message)
    return res.status(500).json({ error: err.message || 'Internal server error' })
  }
})

export default router
