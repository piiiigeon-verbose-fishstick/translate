import { useState, useCallback, useRef } from 'react'
import TextRenderer from './TextRenderer'

function App() {
  const [uploadedFile, setUploadedFile] = useState(null)
  const [sourceText, setSourceText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [isTranslating, setIsTranslating] = useState(false)
  const [error, setError] = useState('')
  const [isParsing, setIsParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState(0)
  const [ocrSettings, setOcrSettings] = useState({
    scale: 1.2,
    enableMathDetection: false
  })
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false)
  const pdfProcessorRef = useRef(null)

  const initPdfProcessor = useCallback(async () => {
    if (!pdfProcessorRef.current) {
      const { PdfProcessor } = await import('./utils/PdfProcessor')
      pdfProcessorRef.current = new PdfProcessor()
      await pdfProcessorRef.current.init()
    }
    return pdfProcessorRef.current
  }, [])

  const parseFile = useCallback(async (file) => {
    setError('')
    setIsParsing(true)
    setParseProgress(0)
    const fileExtension = file.name.split('.').pop().toLowerCase()

    try {
      let text = ''

      if (fileExtension === 'docx') {
        const mammoth = await import('mammoth')
        const data = await file.arrayBuffer()
        const result = await mammoth.extractRawText({ arrayBuffer: data })
        text = result.value
      } else if (fileExtension === 'md') {
        text = await file.text()
      } else if (fileExtension === 'pdf') {
        const processor = await initPdfProcessor()
        text = await processor.extractTextFromPdf(file, ocrSettings)
      } else {
        throw new Error('不支持的文件格式')
      }

      if (!text.trim()) {
        throw new Error('文件内容为空')
      }

      return text
    } catch (err) {
      console.error('文件解析错误:', err)
      const errorMsg = err instanceof Error ? err.message : 
                       typeof err === 'string' ? err : 
                       '未知错误'
      throw new Error(`解析文件失败: ${errorMsg}`)
    } finally {
      setIsParsing(false)
      setParseProgress(100)
    }
  }, [initPdfProcessor, ocrSettings])

  const processFile = useCallback(async (file) => {
    setError('')
    setUploadedFile(file)
    setSourceText('')
    setTranslatedText('')
    setIsSourceCollapsed(false)

    try {
      const text = await parseFile(file)
      setSourceText(text)
    } catch (err) {
      setError(err.message)
      setSourceText('')
    }
  }, [parseFile])

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }, [processFile])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.currentTarget.classList.add('dragover')
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    e.currentTarget.classList.remove('dragover')
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.currentTarget.classList.remove('dragover')
    const file = e.dataTransfer.files?.[0]
    if (file) processFile(file)
  }, [processFile])

  const handleTranslate = useCallback(async () => {
    if (!sourceText.trim()) {
      setError('请先上传文件')
      return
    }

    setIsTranslating(true)
    setTranslatedText('')
    setError('')

    const cjkCount = (sourceText.match(/[一-鿿㐀-䶿]/g) || []).length
    const totalChars = sourceText.replace(/\s/g, '').length || 1
    const isChineseSource = cjkCount / totalChars > 0.3
    const targetLang = isChineseSource ? 'English' : 'Chinese'
    const directionLabel = isChineseSource ? '中→英' : '英→中'

    const RATE_DELAY = 13000

    const callTranslationApi = async (text) => {
      const response = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Hunyuan-MT-7B',
          messages: [
            { role: 'user', content: `Translate the following text to ${targetLang}. Only output the translation, no explanations:\n\n${text}` }
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
          errorMsg = responseText || errorMsg
        }
        throw new Error(errorMsg)
      }

      const data = await response.json()
      const result = data.choices?.[0]?.message?.content
      if (!result) throw new Error('翻译返回为空')
      return result
    }

    const splitTextIntoChunks = (text, chunkSize) => {
      const chunks = []
      let currentChunk = ''

      const paragraphs = text.split('\n\n')

      for (const paragraph of paragraphs) {
        if (currentChunk.length + paragraph.length + 2 <= chunkSize) {
          currentChunk += (currentChunk ? '\n\n' : '') + paragraph
        } else {
          if (currentChunk) chunks.push(currentChunk)
          if (paragraph.length > chunkSize) {
            const sentences = paragraph.split(/(?<=[.!?。！？])\s*/)
            let temp = ''
            for (const sentence of sentences) {
              if (temp.length + sentence.length <= chunkSize) {
                temp += sentence
              } else {
                if (temp) chunks.push(temp)
                temp = sentence
              }
            }
            if (temp) chunks.push(temp)
          } else {
            currentChunk = paragraph
          }
        }
      }

      if (currentChunk) chunks.push(currentChunk)
      return chunks
    }

    const doChunkedTranslation = async () => {
      const chunkSize = isChineseSource ? 1500 : 6000
      const chunks = splitTextIntoChunks(sourceText, chunkSize)
      const totalChunks = chunks.length
      const results = new Array(totalChunks).fill(null)
      let completedCount = 0

      setTranslatedText(`${directionLabel} | 文本较长，分为 ${totalChunks} 段翻译 (0/${totalChunks})`)

      for (let i = 0; i < totalChunks; i++) {
        for (let attempt = 0; attempt <= 3; attempt++) {
          try {
            const result = await callTranslationApi(chunks[i])
            results[i] = result
            completedCount++
            break
          } catch (err) {
            const isRateLimit = err.message.includes('429') || err.message.includes('rate')
            if (attempt === 3) {
              results[i] = `[翻译失败: ${err.message}]`
              completedCount++
              break
            }
            const delay = isRateLimit ? RATE_DELAY + 3000 : Math.min(Math.pow(2, attempt) * 2000, 10000)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }

        const partial = results
          .map((r, idx) => (r !== null ? r : `[等待翻译: 段落 ${idx + 1}]`))
          .join('\n\n')

        const remaining = totalChunks - completedCount
        const waitInfo = i < totalChunks - 1
          ? `\n\n[等待速率限制... 剩余 ${remaining} 段，预计还需约 ${Math.round(remaining * RATE_DELAY / 1000 / 60)} 分钟]`
          : ''

        setTranslatedText(`${directionLabel} | 进度: ${completedCount}/${totalChunks}\n\n${partial}${waitInfo}`)

        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, RATE_DELAY))
        }
      }

      setTranslatedText(results.join('\n\n'))
    }

    try {
      setTranslatedText(`${directionLabel} | 正在翻译...`)
      const result = await callTranslationApi(sourceText)
      setTranslatedText(result)
    } catch (err) {
      const lengthHints = ['context', 'length', 'too long', 'token', 'maximum', 'exceed', 'truncat']
      const isLengthError = lengthHints.some(hint => err.message.toLowerCase().includes(hint))

      if (isLengthError) {
        try {
          await doChunkedTranslation()
        } catch (chunkErr) {
          setError(`翻译失败: ${chunkErr.message}`)
        }
      } else {
        setError(`翻译失败: ${err.message}`)
      }
    } finally {
      setIsTranslating(false)
    }
  }, [sourceText])

  return (
    <div className="app-container">
      <div className="header">
        <h1>AI翻译助手</h1>
        <p>支持 PDF、Word、Markdown 文件一键翻译</p>
      </div>

      <div className="upload-section">
        {error && <div className="error-message">{error}</div>}
        
        <div className="ocr-settings">
          <label className="settings-label">OCR 设置<p>OCR只涉及图片形式PDF，其他格式请忽略此设置</p></label>
          <div className="settings-row">
            <div className="setting-item">
              <label>分辨率:</label>
              <select 
                value={ocrSettings.scale} 
                onChange={(e) => setOcrSettings({...ocrSettings, scale: parseFloat(e.target.value)})}
              >
                <option value={1.2}>快速失真 (1.2x)</option>
                <option value={1.5}>标准 (1.5x)</option>
                <option value={2.0}>高精度 (2.0x)</option>
              </select>
            </div>
            <div className="setting-item">
              <label>
                <input 
                  type="checkbox" 
                  checked={ocrSettings.enableMathDetection}
                  onChange={(e) => setOcrSettings({...ocrSettings, enableMathDetection: e.target.checked})}
                />
                启用公式识别
              </label>
            </div>
          </div>
        </div>
        
        <div
          className="upload-area"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <input
            id="file-input"
            type="file"
            accept=".pdf,.docx,.md"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <div className="upload-icon">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
          <div className="upload-text">
            {isParsing ? '正在解析文件...' : (uploadedFile ? `已选择: ${uploadedFile.name}` : '拖拽文件到这里或点击上传')}
          </div>
          <div className="upload-hint">支持 PDF、DOCX、MD 格式文件</div>
        </div>

        <button
          className="translate-btn"
          onClick={handleTranslate}
          disabled={!sourceText.trim() || isTranslating || isParsing}
        >
          {isTranslating ? '翻译中...' : (isParsing ? '解析中...' : '一键翻译')}
        </button>
      </div>

      <div className="compare-section">
        <div className="document-panel">
          <div className="panel-header">
            <div className="panel-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
              </div>
            <div className="panel-title">原始文档</div>
            {sourceText && (
              <button 
                className="collapse-btn"
                onClick={() => setIsSourceCollapsed(!isSourceCollapsed)}
                title={isSourceCollapsed ? '展开' : '折叠'}
              >
                {isSourceCollapsed ? '▼' : '▲'}
              </button>
            )}
          </div>
          <div className={`document-content ${!sourceText ? 'empty' : ''} ${isSourceCollapsed ? 'collapsed' : ''}`}>
            {sourceText ? (
              isSourceCollapsed ? (
                <div className="collapsed-placeholder">
                  <span>点击上方箭头展开原文</span>
                  <span className="char-count">共 {sourceText.length} 字符</span>
                </div>
              ) : (
                <TextRenderer text={sourceText} />
              )
            ) : '请上传文件查看原始内容'}
          </div>
        </div>

        <div className="document-panel">
          <div className="panel-header">
            <div className="panel-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
              </div>
            <div className="panel-title">翻译结果</div>
          </div>
          <div className="document-content">
            {isTranslating ? (
              <div>
                <div className="loading-indicator">
                  <div className="spinner"></div>
                  <span>AI 正在翻译中...</span>
                </div>
                {translatedText && <TextRenderer text={translatedText} />}
              </div>
            ) : translatedText ? (
              <TextRenderer text={translatedText} />
            ) : (
              <span className="empty">翻译结果将显示在这里</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App