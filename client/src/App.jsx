import { useState, useCallback, useRef, useEffect } from 'react'
import TextRenderer from './TextRenderer'
import * as mammoth from 'mammoth'
import { translateText } from './api/translate'
import { PptProcessor } from './utils/PptProcessor'
import { PdfProcessor } from './utils/PdfProcessor'

const IMG_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])
const SUPPORTED_FORMATS = 'PDF、DOCX、MD、PPTX、PNG、JPG'

function App() {
  const [uploadedFile, setUploadedFile] = useState(null)
  const [sourceText, setSourceText] = useState('')
  const [sourceHtml, setSourceHtml] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [isTranslating, setIsTranslating] = useState(false)
  const [error, setError] = useState('')
  const [isParsing, setIsParsing] = useState(false)
  const [parseMessage, setParseMessage] = useState('')
  const [ocrSettings, setOcrSettings] = useState({
    scale: 1.2
  })
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false)
  const [inputMode, setInputMode] = useState('file')
  const [textInput, setTextInput] = useState('')
  const pdfProcessorRef = useRef(null)

  const [theme, setTheme] = useState(() => {
    try {
      const s = localStorage.getItem('theme')
      if (s === 'dark' || s === 'light') return s
    } catch {}
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('theme', theme) } catch {}
  }, [theme])

  const toggleTheme = useCallback(() => setTheme(t => t === 'light' ? 'dark' : 'light'), [])

  const initPdfProcessor = useCallback(async () => {
    if (!pdfProcessorRef.current) {
      pdfProcessorRef.current = new PdfProcessor()
      await pdfProcessorRef.current.init()
    }
    return pdfProcessorRef.current
  }, [])

  const parseFile = useCallback(async (file) => {
    setError('')
    setIsParsing(true)
    const fileExtension = file.name.split('.').pop().toLowerCase()

    try {
      let text = ''
      let html = ''

      if (fileExtension === 'docx') {
        setParseMessage('正在解析 Word 文档...')
        const data = await file.arrayBuffer()
        const [htmlResult, textResult] = await Promise.all([
          mammoth.convertToHtml({ arrayBuffer: data }),
          mammoth.extractRawText({ arrayBuffer: data })
        ])
        html = htmlResult.value
        text = textResult.value
      } else if (fileExtension === 'md') {
        setParseMessage('正在读取 Markdown...')
        text = await file.text()
      } else if (fileExtension === 'pptx') {
        setParseMessage('正在解析演示文稿...')
        const processor = new PptProcessor()
        text = await processor.extractText(file)
      } else if (fileExtension === 'pdf') {
        const processor = await initPdfProcessor()
        text = await processor.extractTextFromPdf(file, {
          scale: ocrSettings.scale,
          onProgress: (p) => {
            if (p.phase === 'text') {
              setParseMessage(`正在提取文本... ${p.current}/${p.total} 页`)
            } else if (p.phase === 'ocr') {
              setParseMessage(`正在OCR识别... ${p.current}/${p.total} 页`)
            }
          }
        })
      } else if (IMG_EXTENSIONS.has(fileExtension)) {
        setParseMessage('正在 OCR 识别图片...')
        const processor = await initPdfProcessor()
        text = await processor.extractTextFromImage(file, {
          onProgress: () => {}
        })
      } else {
        throw new Error('不支持的文件格式')
      }

      if (!text.trim() && !html.trim()) {
        throw new Error('文件内容为空')
      }

      return { text, html }
    } catch (err) {
      console.error('文件解析错误:', err)
      const errorMsg = err instanceof Error ? err.message :
                       typeof err === 'string' ? err :
                       '未知错误'
      throw new Error(`解析文件失败: ${errorMsg}`)
    } finally {
      setIsParsing(false)
      setParseMessage('')
    }
  }, [initPdfProcessor, ocrSettings.scale])

  const processFile = useCallback(async (file) => {
    setError('')
    setUploadedFile(file)
    setSourceText('')
    setSourceHtml('')
    setTranslatedText('')
    setIsSourceCollapsed(false)

    try {
      const { text, html } = await parseFile(file)
      setSourceText(text)
      setSourceHtml(html || '')
    } catch (err) {
      setError(err.message)
      setSourceText('')
      setSourceHtml('')
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

  const handleTextSubmit = useCallback(() => {
    if (!textInput.trim()) return
    setError('')
    setUploadedFile(null)
    setSourceHtml('')
    setSourceText(textInput.trim())
    setTranslatedText('')
    setIsSourceCollapsed(false)
  }, [textInput])

  const handleTextClear = useCallback(() => {
    setTextInput('')
    setSourceText('')
    setSourceHtml('')
    setTranslatedText('')
    setUploadedFile(null)
    setError('')
  }, [])

  const handleInputModeChange = useCallback((mode) => {
    setInputMode(mode)
    setError('')
    if (mode === 'file') {
      setTextInput('')
    }
  }, [])

  const handleTranslate = useCallback(async () => {
    if (!sourceText.trim()) {
      setError('请先上传文件或输入文本')
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

    try {
      setTranslatedText(`${directionLabel} | 正在翻译...`)
      const cleanText = sourceText.replace(/\x00UNCLEAR\x00(.*?)\x00\/UNCLEAR\x00/g, '$1')
      const result = await translateText(cleanText, targetLang)
      setTranslatedText(result.translatedText)
    } catch (err) {
      setError(`翻译失败: ${err.message}`)
    } finally {
      setIsTranslating(false)
    }
  }, [sourceText])

  return (
    <div className="app-container">
      <div className="header-row">
        <div>
          <h1>AI翻译助手</h1>
          <p>支持 {SUPPORTED_FORMATS} 文件一键翻译</p>
        </div>
        <button
          className="theme-toggle-btn"
          onClick={toggleTheme}
          title={theme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
          aria-label="切换主题"
        >
          {theme === 'light' ? '◐' : '◑'}
        </button>
      </div>

      <div className="upload-section">
        {error && <div className="error-message">{error}</div>}

        <div className="input-mode-toggle">
          <button
            className={`input-mode-btn ${inputMode === 'file' ? 'active' : ''}`}
            onClick={() => handleInputModeChange('file')}
          >
            上传文件
          </button>
          <button
            className={`input-mode-btn ${inputMode === 'text' ? 'active' : ''}`}
            onClick={() => handleInputModeChange('text')}
          >
            直接输入
          </button>
        </div>

        {inputMode === 'file' ? (
          <>
            <div className="ocr-settings">
              <label className="settings-label">OCR 设置<span className="settings-hint">（图片型 PDF / 图片文件会使用 OCR）</span></label>
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
                accept=".pdf,.docx,.md,.pptx,.png,.jpg,.jpeg,.webp,.bmp"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
              <div className="upload-icon">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <div className="upload-text">
                {isParsing ? parseMessage : (uploadedFile ? `已选择: ${uploadedFile.name}` : '拖拽文件到这里或点击上传')}
              </div>
              <div className="upload-hint">支持 {SUPPORTED_FORMATS} 格式文件</div>
            </div>
          </>
        ) : (
          <div className="text-input-wrapper">
            <textarea
              className="text-input-area"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="在此输入或粘贴要翻译的文本…"
            />
            <div className="text-input-footer">
              <span className="char-count">{textInput.length} 字符</span>
              <div className="text-input-actions">
                <button className="text-clear-btn" onClick={handleTextClear}>清空</button>
                <button
                  className="load-btn"
                  onClick={handleTextSubmit}
                  disabled={isTranslating || isParsing || !textInput.trim()}
                >
                  载入文本
                </button>
                <button
                  className="translate-btn text-translate-btn"
                  onClick={handleTranslate}
                  disabled={isTranslating || isParsing || !sourceText.trim()}
                >
                  {isTranslating ? '翻译中...' : '一键翻译'}
                </button>
              </div>
            </div>
          </div>
        )}

        {inputMode === 'file' && (
          <button
            className="translate-btn"
            onClick={handleTranslate}
            disabled={isTranslating || isParsing || !sourceText.trim()}
          >
            {isTranslating ? '翻译中...' : (isParsing ? '解析中...' : '一键翻译')}
          </button>
        )}
      </div>

      <div className="compare-section">
        <div className="document-panel">
          <div className="panel-header">
            <div className="panel-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              ) : sourceHtml ? (
                <TextRenderer html={sourceHtml} text={sourceText} />
              ) : (
                <TextRenderer text={sourceText} />
              )
            ) : '请上传文件或输入文本查看原始内容'}
          </div>
        </div>

        <div className="document-panel">
          <div className="panel-header">
            <div className="panel-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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