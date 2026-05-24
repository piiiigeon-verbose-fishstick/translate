import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker?url'
import { createWorker } from 'tesseract.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

const MAX_CANVAS_DIM = 3072
const TEXT_RICH_THRESHOLD = 200   // chars above this → definitely text page, skip image check
const TEXT_SPARSE_THRESHOLD = 20   // chars below this → likely empty/image-only page

const IMAGE_OPS = new Set([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintJpegXObject,
  pdfjsLib.OPS.paintJpxImage,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintImageMaskXObject
])

export class PdfProcessor {
  constructor() {
    this.scale = 1.2
    this.maxConcurrentPages = 4
    this.worker = null
  }

  async init() {
    if (this.worker) return
    this.worker = await createWorker('eng+chi_sim')
  }

  // ---- Direct image OCR (PNG / JPG) ----

  async extractTextFromImage(file, options = {}) {
    const { onProgress } = options
    onProgress?.({ phase: 'ocr', current: 1, total: 1 })

    const imageData = await this._fileToDataURL(file)
    const result = await this.worker.recognize(imageData, { output: 'hocr' })

    if (result.data?.hocr) {
      const hocrText = this.parseHOCRSimple(result.data.hocr)
      if (hocrText.trim()) return hocrText
    }
    return result.data?.text?.trim() || ''
  }

  async _fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // ---- PDF extraction ----

  async extractTextFromPdf(file, options = {}) {
    const data = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data }).promise

    const {
      scale = this.scale,
      onProgress
    } = options

    const pageTexts = []

    for (let i = 1; i <= pdf.numPages; i++) {
      let pageText = ''
      let hasImages = false

      // Try text layer extraction first
      onProgress?.({ phase: 'text', current: i, total: pdf.numPages })
      try {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        pageText = this.structureText(content.items)
      } catch (e) {
        console.warn(`Page ${i} text extraction failed:`, e.message)
      }

      const textLen = pageText.replace(/\s/g, '').length

      // Decision: check for images when text is sparse
      if (textLen < TEXT_RICH_THRESHOLD) {
        try {
          const page = await pdf.getPage(i)
          const ops = await page.getOperatorList()
          hasImages = ops.fnArray.some(fn => IMAGE_OPS.has(fn))
        } catch (e) {
          console.warn(`Page ${i} operator list failed:`, e.message)
        }
      }

      if (textLen < TEXT_SPARSE_THRESHOLD && hasImages) {
        // Almost no text + has images: pure image page, OCR only
        try {
          const ocrText = await this.processPageForOCR(pdf, i, { scale })
          if (ocrText.trim()) {
            pageText = `--- 第 ${i} 页 ---\n${ocrText.trim()}`
          }
        } catch (ocrErr) {
          console.warn(`Page ${i} OCR failed:`, ocrErr.message)
        }
      } else if (textLen >= TEXT_SPARSE_THRESHOLD && textLen < TEXT_RICH_THRESHOLD && hasImages) {
        // Mix of text and images: merge both
        try {
          const ocrText = await this.processPageForOCR(pdf, i, { scale })
          if (ocrText.trim()) {
            pageText = pageText.trim()
              ? `${pageText.trim()}\n\n[图片内容]\n${ocrText.trim()}`
              : `--- 第 ${i} 页 ---\n${ocrText.trim()}`
          }
        } catch (ocrErr) {
          console.warn(`Page ${i} OCR failed:`, ocrErr.message)
        }
      }
      // else: rich text (>=200 chars) or sparse text without images → use text extraction only

      if (pageText.trim()) {
        pageTexts.push(pageText.trim())
      }
    }

    const fullText = pageTexts.join('\n\n')
    if (!fullText.trim()) {
      throw new Error('无法从PDF中提取文字，请确认PDF中包含清晰的文字')
    }

    return fullText
  }

  // ---- Text structuring with heading detection ----

  structureText(items) {
    if (!items || items.length === 0) return ''

    // Group items into lines by Y coordinate
    const lines = []
    let currentLine = []
    let lastY = null

    const sorted = [...items].sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5]
      if (Math.abs(yDiff) > 5) return yDiff
      return a.transform[4] - b.transform[4]
    })

    sorted.forEach((item) => {
      const y = item.transform[5]
      if (lastY !== null && Math.abs(lastY - y) > 2) {
        if (currentLine.length) lines.push(currentLine)
        currentLine = []
      }
      currentLine.push(item)
      lastY = y
    })
    if (currentLine.length) lines.push(currentLine)

    // Calculate heights for each line
    const lineData = lines.map(line => {
      const heights = line.map(item => Math.abs(item.transform[0]) || item.height || 0)
      const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length
      const text = line.map(item => item.str).join('')
      const isBold = line.some(item =>
        item.fontName?.includes('Bold') || item.fontName?.includes('bold'))
      const isItalic = line.some(item =>
        item.fontName?.includes('Italic') || item.fontName?.includes('italic'))
      return { text, height: avgHeight, isBold, isItalic }
    })

    // Find the median height (body text baseline)
    const heights = lineData.map(l => l.height).sort((a, b) => a - b)
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12

    // Build output with heading markers
    let result = ''
    for (const line of lineData) {
      const ratio = line.height / medianHeight
      let prefix = ''

      if (ratio > 1.6) {
        prefix = '## '
      } else if (ratio > 1.3) {
        prefix = '### '
      }

      let text = line.text
      if (line.isBold && line.isItalic) {
        text = `**_${text}_**`
      } else if (line.isBold) {
        text = `**${text}**`
      } else if (line.isItalic) {
        text = `_${text}_`
      }

      result += prefix + text + '\n\n'
    }

    return result.trim()
  }

  // ---- OCR ----

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
      console.warn('HOCR parse failed:', e.message)
      return ''
    }
  }
}
