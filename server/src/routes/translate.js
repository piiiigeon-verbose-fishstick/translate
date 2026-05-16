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
          role: 'user',
          content: `Translate the following text to ${targetLang}. Only output the translation, no explanations:\n\n${text}`
        }
      ],
      max_tokens: 4096,
      temperature: 0.1
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

    try {
      await rateLimiter.wait()
      const result = await callTranslationApi(text, targetLang)
      return res.json({ translatedText: result, chunked: false })
    } catch (err) {
      if (!isContextLengthError(err.message)) {
        throw err
      }

      const chunks = splitTextIntoChunks(text)
      if (chunks.length <= 1) throw err

      const results = []
      for (let i = 0; i < chunks.length; i++) {
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            await rateLimiter.wait()
            const result = await callTranslationApi(chunks[i], targetLang)
            results.push(result)
            break
          } catch (chunkErr) {
            if (attempt === 2) {
              results.push(`[Translation failed: ${chunkErr.message}]`)
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
        chunksTotal: chunks.length
      })
    }
  } catch (err) {
    console.error('Translation error:', err)
    return res.status(500).json({ error: err.message || 'Internal server error' })
  }
})

export default router
