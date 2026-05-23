import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker?url'
import { createWorker } from 'tesseract.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

const MAX_CANVAS_DIM = 3072

export class PdfProcessor {
  constructor() {
    this.scale = 1.2
    this.maxConcurrentPages = 4
    this.enableMathDetection = false
    this.worker = null
  }

  async init() {
    if (this.worker) return
    this.worker = await createWorker('eng+chi_sim')
  }

  async extractTextFromPdf(file, options = {}) {
    const data = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data }).promise

    const {
      enableMathDetection = this.enableMathDetection,
      scale = this.scale,
      onProgress
    } = options

    const pageTexts = []

    for (let i = 1; i <= pdf.numPages; i++) {
      let pageText = ''

      // Try text layer extraction first for this page
      onProgress?.({ phase: 'text', current: i, total: pdf.numPages })
      try {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        pageText = this.structureText(content.items)
      } catch (e) {
        console.warn(`第${i}页文本提取失败:`, e.message)
      }

      // If text extraction yielded too little, fall back to OCR for this page
      if (pageText.trim().length < 30) {
        try {
          const ocrText = await this.processPageForOCR(pdf, i, { scale })
          if (ocrText.trim()) {
            pageText = `--- 第 ${i} 页 ---\n${ocrText.trim()}`
          }
        } catch (ocrErr) {
          console.warn(`第${i}页OCR失败:`, ocrErr.message)
        }
      }

      if (pageText.trim()) {
        pageTexts.push(pageText.trim())
      }
    }

    const fullText = pageTexts.join('\n\n')
    if (!fullText.trim()) {
      throw new Error('无法从PDF中提取文字，请确认PDF中包含清晰的文字')
    }

    return enableMathDetection ? this.extractMathFormulas(fullText) : fullText
  }

  async extractTextContent(pdf, onProgress) {
    let fullText = ''

    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.({ phase: 'text', current: i, total: pdf.numPages })
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const structuredText = this.structureText(content.items)
      fullText += structuredText + '\n\n'
    }

    return fullText.trim()
  }

  structureText(items) {
    if (!items || items.length === 0) return ''

    items.sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5]
      if (Math.abs(yDiff) > 5) return yDiff
      return a.transform[4] - b.transform[4]
    })

    let result = ''
    let lastY = null

    items.forEach((item, index) => {
      const currentY = item.transform[5]

      if (lastY !== null && lastY - currentY > 10) {
        result += '\n\n'
      } else if (lastY !== null && lastY - currentY > 2) {
        result += '\n'
      } else if (index > 0) {
        result += ' '
      }

      const isBold = item.fontName?.includes('Bold') || item.fontName?.includes('bold')
      const isItalic = item.fontName?.includes('Italic') || item.fontName?.includes('italic')

      if (isBold && isItalic) {
        result += `**_${item.str}_**`
      } else if (isBold) {
        result += `**${item.str}**`
      } else if (isItalic) {
        result += `_${item.str}_`
      } else {
        result += item.str
      }

      lastY = currentY
    })

    return result.trim()
  }

  async performOCR(pdf, options = {}) {
    const numPages = pdf.numPages
    const results = []
    const { scale = this.scale, onProgress } = options

    for (let i = 0; i < numPages; i += this.maxConcurrentPages) {
      const promises = []
      const end = Math.min(i + this.maxConcurrentPages, numPages)

      for (let j = i; j < end; j++) {
        promises.push(this.processPageForOCR(pdf, j + 1, { scale, onProgress }))
      }

      const pageResults = await Promise.all(promises)
      results.push(...pageResults.filter(r => r.trim()))

      for (let j = i; j < end; j++) {
        onProgress?.({ phase: 'ocr', current: j + 1, total: numPages })
      }
    }

    return results.join('\n\n')
  }

  async processPageForOCR(pdf, pageNum, options = {}) {
    const { scale = this.scale } = options

    const page = await pdf.getPage(pageNum)
    let viewport = page.getViewport({ scale })

    // Cap canvas size to stay within browser limits
    if (viewport.width > MAX_CANVAS_DIM || viewport.height > MAX_CANVAS_DIM) {
      const ratio = Math.min(MAX_CANVAS_DIM / viewport.width, MAX_CANVAS_DIM / viewport.height)
      viewport = page.getViewport({ scale: scale * ratio })
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error(`无法创建渲染画布 (${canvas.width}x${canvas.height})`)
    }

    try {
      await page.render({
        canvasContext: context,
        viewport: viewport
      }).promise
    } catch (renderError) {
      throw new Error(`第${pageNum}页渲染失败: ${renderError.message}`)
    }

    const imageData = canvas.toDataURL('image/png')

    let result
    try {
      result = await this.worker.recognize(imageData, { output: 'hocr' })
    } catch (ocrError) {
      throw new Error(`第${pageNum}页OCR失败: ${ocrError.message}`)
    }

    if (!result.data || (!result.data.hocr && !result.data.text)) {
      return ''
    }

    if (result.data.hocr) {
      const hocrText = this.parseHOCRSimple(result.data.hocr)
      if (hocrText.trim()) {
        return hocrText
      }
    }

    return result.data.text?.trim() || ''
  }

  parseHOCRSimple(hocr) {
    if (!hocr || typeof hocr !== 'string') {
      return ''
    }

    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(hocr, 'text/html')
      const words = doc.querySelectorAll('span[class="ocrx_word"]')

      if (!words || words.length === 0) {
        return ''
      }

      let result = ''
      let lastY = null

      words.forEach((word) => {
        const title = word.getAttribute('title') || ''
        const bbox = title.match(/bbox (\d+) (\d+) (\d+) (\d+)/)
        if (!bbox) return

        const wconfMatch = title.match(/x_wconf (\d+)/)
        const confidence = wconfMatch ? parseInt(wconfMatch[1]) : 100

        const y1 = parseInt(bbox[2])
        const text = word.textContent?.trim()

        if (!text) return

        if (lastY !== null && y1 - lastY > 15) {
          result += '\n\n'
        } else if (lastY !== null) {
          result += ' '
        }

        if (confidence < 70) {
          result += `\x00UNCLEAR\x00${text}\x00/UNCLEAR\x00`
        } else {
          result += text
        }
        lastY = y1
      })

      return result.trim()
    } catch (e) {
      console.warn('HOCR解析失败:', e.message)
      return ''
    }
  }

  extractMathFormulas(text) {
    if (!text) return ''

    const mathPatterns = [
      /([a-zA-Z]+\s*[=<>≥≤≠]?\s*[0-9]+(\.[0-9]+)?(\s*[+\-*/^]\s*[a-zA-Z0-9.]+)+)/g,
      /(\(\s*[a-zA-Z0-9]+\s*[+\-*/]\s*[a-zA-Z0-9]+\s*\))/g,
      /([a-zA-Z]+\s*\(\s*[a-zA-Z0-9, ]+\s*\))/g,
      /(\$[^$]+\$)/g,
      /(\\frac\{[^}]+\}\{[^}]+\})/g,
      /(\\sqrt\{[^}]+\})/g,
      /([0-9]+\s*x\s*\^\s*[0-9]+)/g
    ]

    let result = text

    mathPatterns.forEach((pattern) => {
      result = result.replace(pattern, (match) => {
        if (!match.includes('$')) {
          return `$${match}$`
        }
        return match
      })
    })

    return result
  }
}
