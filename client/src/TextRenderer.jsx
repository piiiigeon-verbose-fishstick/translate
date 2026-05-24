import { useMemo, useState, useEffect } from 'react'
import MarkdownIt from 'markdown-it'
import 'katex/dist/katex.min.css'

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true
})

function TextRenderer({ text, html }) {
  const [katex, setKatex] = useState(null)

  useEffect(() => {
    let cancelled = false
    import('katex').then(m => {
      if (!cancelled) setKatex(() => m.default)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const renderedContent = useMemo(() => {
    // HTML passthrough for pre-rendered content (e.g. DOCX via mammoth)
    if (html) {
      return html
    }

    if (!text) return ''

    let result = text

    // Protect OCR confidence markers before markdown processing
    const unclearMarkers = []
    result = result.replace(/\x00UNCLEAR\x00([\s\S]*?)\x00\/UNCLEAR\x00/g, (_, word) => {
      const idx = unclearMarkers.length
      const escaped = word.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      unclearMarkers.push(`<span class="ocr-low-confidence" title="OCR识别置信度低">${escaped}</span>`)
      return `\x00UN_${idx}\x00`
    })

    // Protect LaTeX math blocks before markdown processing
    const mathBlocks = []

    result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
      const idx = mathBlocks.length
      mathBlocks.push({ formula: formula.trim(), display: true })
      return `\x00MB_${idx}\x00`
    })

    result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => {
      const idx = mathBlocks.length
      mathBlocks.push({ formula: formula.trim(), display: true })
      return `\x00MB_${idx}\x00`
    })

    result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => {
      const idx = mathBlocks.length
      mathBlocks.push({ formula: formula.trim(), display: false })
      return `\x00MB_${idx}\x00`
    })

    result = result.replace(/\$(.+?)\$/g, (_, formula) => {
      const idx = mathBlocks.length
      mathBlocks.push({ formula: formula.trim(), display: false })
      return `\x00MB_${idx}\x00`
    })

    // Auto-fix headings missing space: "#Heading" → "# Heading"
    result = result.replace(/^(#{1,6})([^\s#])/gm, '$1 $2')

    result = md.render(result)

    // Unwrap block math placeholders from <p> tags
    result = result.replace(/<p>\x00MB_(\d+)\x00<\/p>\n?/g, (_, idx) => {
      const mb = mathBlocks[parseInt(idx)]
      return mb.display ? `\x00MB_${idx}\x00` : `<p>\x00MB_${idx}\x00</p>`
    })

    if (katex) {
      result = result.replace(/\x00MB_(\d+)\x00/g, (_, idx) => {
        const mb = mathBlocks[parseInt(idx)]
        try {
          return katex.renderToString(mb.formula, {
            throwOnError: false,
            displayMode: mb.display,
            trust: false
          })
        } catch {
          return mb.display
            ? `<div class="formula-block">$$${mb.formula}$$</div>`
            : `<span class="formula-inline">$${mb.formula}$</span>`
        }
      })
    } else {
      result = result.replace(/\x00MB_(\d+)\x00/g, (_, idx) => {
        const mb = mathBlocks[parseInt(idx)]
        const escaped = mb.formula.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return mb.display
          ? `<div class="formula-block">$$${escaped}$$</div>`
          : `<span class="formula-inline">$${escaped}$</span>`
      })
    }

    result = result.replace(/\x00UN_(\d+)\x00/g, (_, idx) => unclearMarkers[parseInt(idx)])

    return result
  }, [text, html, katex])

  return (
    <div
      className="rendered-content"
      dangerouslySetInnerHTML={{ __html: renderedContent }}
    />
  )
}

export default TextRenderer
