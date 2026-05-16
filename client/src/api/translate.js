const API_URL = import.meta.env.VITE_API_URL || '/api'

export async function translateText(text, targetLang) {
  const response = await fetch(`${API_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLang })
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${response.status}`)
  }

  const data = await response.json()
  return {
    translatedText: data.translatedText,
    chunked: data.chunked || false
  }
}
