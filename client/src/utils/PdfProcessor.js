import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker?url'
import { createWorker } from 'tesseract.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

export class PdfProcessor {
  constructor() {
    this.scale = 1.2
    this.maxConcurrentPages = 4
    this.enableMathDetection = false
    this.worker = null
  }

  async init() {
    this.worker = await createWorker('eng+chi_sim')
  }

  async extractTextFromPdf(file, options = {}) {
    const data = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data }).promise
    
    const { 
      enableMathDetection = this.enableMathDetection,
      scale = this.scale
    } = options

    let textContent = ''
    
    try {
      textContent = await this.extractTextContent(pdf)
    } catch (extractError) {
      console.warn('文本提取失败，尝试OCR:', extractError.message)
    }
    
    if (textContent.trim()) {
      return enableMathDetection ? this.extractMathFormulas(textContent) : textContent
    }
    
    let ocrText = ''
    try {
      ocrText = await this.performOCR(pdf, { scale })
    } catch (ocrError) {
      console.warn('OCR失败:', ocrError.message)
    }
    
    return enableMathDetection ? this.extractMathFormulas(ocrText) : ocrText
  }

  async extractTextContent(pdf) {
    let fullText = ''
    
    for (let i = 1; i <= pdf.numPages; i++) {
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
    const { scale = this.scale } = options
    
    for (let i = 0; i < numPages; i += this.maxConcurrentPages) {
      const promises = []
      const end = Math.min(i + this.maxConcurrentPages, numPages)
      
      for (let j = i; j < end; j++) {
        promises.push(this.processPageForOCR(pdf, j + 1, { scale }))
      }
      
      const pageResults = await Promise.all(promises)
      results.push(...pageResults.filter(r => r.trim()))
    }
    
    return results.join('\n\n')
  }

  async processPageForOCR(pdf, pageNum, options = {}) {
    const { scale = this.scale } = options
    
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    canvas.width = viewport.width
    canvas.height = viewport.height
    
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise
    
    const imageData = canvas.toDataURL('image/png')
    
    const result = await this.worker.recognize(imageData, {
      output: 'hocr'
    })
    
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
        const bbox = word.getAttribute('title')?.match(/bbox (\d+) (\d+) (\d+) (\d+)/)
        if (!bbox) return
        
        const y1 = parseInt(bbox[2])
        const text = word.textContent?.trim()
        
        if (!text) return
        
        if (lastY !== null && y1 - lastY > 15) {
          result += '\n\n'
        } else if (lastY !== null) {
          result += ' '
        }
        
        result += text
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