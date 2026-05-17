const API_URL = import.meta.env.VITE_API_URL || '/api'
const REQUEST_TIMEOUT_MS = 120000

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    return response
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时，服务器可能正在启动（免费托管冷启动需要约30-50秒），请稍后重试')
    }
    if (err.message === 'Failed to fetch' || err.message.includes('fetch')) {
      throw new Error('无法连接服务器，请检查网络后重试')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function translateText(text, targetLang) {
  const response = await fetchWithTimeout(`${API_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLang })
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `服务器错误 (HTTP ${response.status})`)
  }

  const data = await response.json()
  return {
    translatedText: data.translatedText,
    chunked: data.chunked || false
  }
}
