import JSZip from 'jszip'

const SLIDE_RX = /^ppt\/slides\/slide(\d+)\.xml$/i
const DM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

export class PptProcessor {
  async extractText(file) {
    const data = await file.arrayBuffer()
    const zip = await JSZip.loadAsync(data)

    const slideNames = Object.keys(zip.files)
      .filter(n => SLIDE_RX.test(n))
      .sort((a, b) => {
        const na = parseInt(a.match(SLIDE_RX)[1])
        const nb = parseInt(b.match(SLIDE_RX)[1])
        return na - nb
      })

    if (slideNames.length === 0) {
      throw new Error('PPTX文件中未找到幻灯片，请确认文件格式正确')
    }

    const texts = []
    for (let i = 0; i < slideNames.length; i++) {
      const xml = await zip.files[slideNames[i]].async('text')
      const text = this._extractSlideText(xml)
      if (text.trim()) {
        texts.push(`--- 第 ${i + 1} 页 ---\n${text.trim()}`)
      }
    }

    if (texts.length === 0) {
      throw new Error('PPTX文件中未找到文本内容')
    }

    return texts.join('\n\n')
  }

  _extractSlideText(xmlString) {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlString, 'text/xml')

    if (doc.querySelector('parsererror')) {
      return ''
    }

    const textElements = doc.getElementsByTagNameNS(DM_NS, 't')
    const parts = []
    for (const el of textElements) {
      if (el.textContent) {
        parts.push(el.textContent)
      }
    }

    return parts.join('')
  }
}
