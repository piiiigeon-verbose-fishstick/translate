import { useMemo, useState, useEffect } from 'react'
import 'katex/dist/katex.min.css'

function TextRenderer({ text }) {
  const [katex, setKatex] = useState(null)

  useEffect(() => {
    let cancelled = false
    import('katex').then(m => {
      if (!cancelled) setKatex(() => m.default)
    })
    return () => { cancelled = true }
  }, [])

  const renderedContent = useMemo(() => {
    if (!text) return ''

    let result = text

    result = result.replace(/&/g, '&amp;')
    result = result.replace(/</g, '&lt;')
    result = result.replace(/>/g, '&gt;')

    const codeBlocks = []
    result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length
      codeBlocks.push(`<pre class="code-block"><code>${code.trim()}</code></pre>`)
      return `\x00CODEBLOCK_${idx}\x00`
    })

    const inlineCodes = []
    result = result.replace(/`([^`]+)`/g, (_, code) => {
      const idx = inlineCodes.length
      inlineCodes.push(`<code class="inline-code">${code}</code>`)
      return `\x00INLINECODE_${idx}\x00`
    })

    if (katex) {
      const mathPatterns = [
        /\\\[([\s\S]*?)\\\]/g,
        /\\\(([\s\S]*?)\\\)/g,
        /\$\$([\s\S]*?)\$\$/g,
        /\$(.*?)\$/g
      ]

      mathPatterns.forEach((pattern, index) => {
        const isBlock = index === 0 || index === 2
        result = result.replace(pattern, (match, formula) => {
          try {
            return katex.renderToString(formula.trim(), {
              throwOnError: false,
              displayMode: isBlock
            })
          } catch {
            return isBlock
              ? `<div class="formula-error">${formula}</div>`
              : `<span class="formula-error">${formula}</span>`
          }
        })
      })
    }

    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>')
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    result = result.replace(/_([^_]+)_/g, '<em>$1</em>')

    result = result.replace(/(?:^\s*\d+\.\s+.*(?:\n|$))+/gm, (match) => {
      const items = match.trim().split('\n')
        .map(line => `<li>${line.replace(/^\s*\d+\.\s+/, '')}</li>`)
        .join('')
      return `<ol>${items}</ol>`
    })

    result = result.replace(/(?:^\s*[-*+]\s+.*(?:\n|$))+/gm, (match) => {
      const items = match.trim().split('\n')
        .map(line => `<li>${line.replace(/^\s*[-*+]\s+/, '')}</li>`)
        .join('')
      return `<ul>${items}</ul>`
    })

    result = result.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)])
    result = result.replace(/\x00INLINECODE_(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)])

    result = result.replace(/\n\n/g, '</p><p>')
    result = result.replace(/\n/g, '<br/>')

    if (!result.startsWith('<p>') && !result.startsWith('<ul>') && !result.startsWith('<ol>') && !result.startsWith('<table>') && !result.startsWith('<pre>')) {
      result = `<p>${result}</p>`
    }

    return result
  }, [text, katex])

  return (
    <div
      className="rendered-content"
      dangerouslySetInnerHTML={{ __html: renderedContent }}
    />
  )
}

export default TextRenderer
