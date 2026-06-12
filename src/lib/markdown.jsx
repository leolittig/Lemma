// Markdown + LaTeX rendering, shared by every place that displays model
// output. Two render paths exist:
//
//   1. Completed messages: marked.parse() produces an HTML string
//      (see components/BubbleText.jsx).
//   2. Streaming messages: marked.lexer() produces tokens which the
//      renderTokens() function below turns into React elements, so each new
//      word can fade in without re-rendering (blinking) the whole message.
//
// Always import `marked` from THIS module (not from 'marked' directly):
// importing it here guarantees the KaTeX configuration below has run.

import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// Configure marked to parse LaTeX math formulas using KaTeX. nonStandard lets
// inline math sit flush against adjacent punctuation — without it the default
// rule rejects common cases like "($\infty$)" or "($\mathbf{d[v]}$)" (a closing
// "$" directly before ")") and leaves them as raw source.
marked.use(markedKatex({
  throwOnError: false,
  nonStandard: true,
}));

// `$$…$$` written mid-sentence is parsed as inline math but tagged
// displayMode:true, which KaTeX renders as a centered block — breaking the
// equation onto its own line in the middle of the surrounding text. Math that
// sits inline (inlineKatex) should always render inline; only true block math
// (blockKatex, on its own line) stays in display mode. This walkTokens runs for
// the completed-message render (marked.parse); the streaming renderToken path
// applies the same rule directly.
marked.use({
  walkTokens(token) {
    if (token.type === 'inlineKatex') token.displayMode = false;
  },
});

export { marked };

// Decode the HTML entities marked escapes into text tokens, since we render
// token text through React (which escapes again) rather than as HTML.
export const decodeEntities = (text) => {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
};

// Split plain text into word spans so each newly streamed word can fade in
// individually (the .word-fade animation) without blinking earlier words.
const renderTextWords = (text, keyPath) => {
  const decodedText = decodeEntities(text);
  const words = decodedText.split(/(\s+)/);
  return words.map((word, index) => {
    if (/^\s+$/.test(word)) {
      return <span key={`${keyPath}-w-${index}`}>{word}</span>;
    }
    return (
      <span key={`${keyPath}-w-${index}-${word}`} className="word-fade">
        {word}
      </span>
    );
  });
};

// Recursive token renderer for streaming markdown. Mirrors what marked.parse
// would emit, but as React elements with stable keys, so React can preserve
// already-rendered words across re-renders while the message grows.
const renderToken = (token, keyPath) => {
  switch (token.type) {
    case 'paragraph':
      return <p key={keyPath}>{renderTokens(token.tokens, `${keyPath}-p`)}</p>;
    case 'heading': {
      const Tag = `h${token.depth}`;
      return <Tag key={keyPath}>{renderTokens(token.tokens, `${keyPath}-h`)}</Tag>;
    }
    case 'list': {
      const Tag = token.ordered ? 'ol' : 'ul';
      return <Tag key={keyPath}>{renderTokens(token.items, `${keyPath}-l`)}</Tag>;
    }
    case 'list_item':
      return <li key={keyPath}>{renderTokens(token.tokens, `${keyPath}-li`)}</li>;
    case 'strong':
      return <strong key={keyPath}>{renderTokens(token.tokens, `${keyPath}-strong`)}</strong>;
    case 'em':
      return <em key={keyPath}>{renderTokens(token.tokens, `${keyPath}-em`)}</em>;
    case 'codespan':
      return <code key={keyPath}>{decodeEntities(token.text)}</code>;
    case 'code':
      return (
        <pre key={keyPath}>
          <code>{decodeEntities(token.text)}</code>
        </pre>
      );
    case 'br':
      return <br key={keyPath} />;
    case 'space':
      return null;
    case 'hr':
      return <hr key={keyPath} />;
    case 'blockquote':
      return <blockquote key={keyPath}>{renderTokens(token.tokens, `${keyPath}-bq`)}</blockquote>;
    case 'link':
      return (
        <a
          key={keyPath}
          href={token.href}
          title={token.title || undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderTokens(token.tokens, `${keyPath}-a`)}
        </a>
      );
    case 'image':
      return <img key={keyPath} src={token.href} alt={token.text} title={token.title || undefined} />;
    case 'del':
      return <del key={keyPath}>{renderTokens(token.tokens, `${keyPath}-del`)}</del>;
    case 'escape':
      return <span key={keyPath}>{decodeEntities(token.text)}</span>;
    // marked-katex-extension emits these token types (not inlineMath/blockMath).
    // Each carries its own displayMode, so honour it rather than assuming.
    case 'inlineKatex':
    case 'inlineMath':
      return (
        <span
          key={keyPath}
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(token.text, { displayMode: false, throwOnError: false }),
          }}
        />
      );
    case 'blockKatex':
    case 'blockMath':
      return (
        <div
          key={keyPath}
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(token.text, { displayMode: token.displayMode !== false, throwOnError: false }),
          }}
        />
      );
    case 'table':
      return renderTable(token, keyPath);
    case 'text':
      if (token.tokens) {
        return renderTokens(token.tokens, `${keyPath}-t`);
      }
      return renderTextWords(token.text, keyPath);
    default:
      return <span key={keyPath}>{decodeEntities(token.text || token.raw)}</span>;
  }
};

// One table cell (header or body), honoring the column's alignment.
const renderCell = (Tag, cell, align, key) => (
  <Tag key={key} style={align ? { textAlign: align } : {}}>
    {cell.tokens ? renderTokens(cell.tokens, `${key}-c`) : cell.text}
  </Tag>
);

// The wrapper div lets wide tables scroll horizontally in place.
const renderTable = (token, keyPath) => (
  <div key={keyPath} className="table-container">
    <table>
      <thead>
        <tr>
          {token.header.map((cell, col) =>
            renderCell('th', cell, token.align[col], `${keyPath}-th-${col}`))}
        </tr>
      </thead>
      <tbody>
        {token.rows.map((row, rowIndex) => (
          <tr key={`${keyPath}-tr-${rowIndex}`}>
            {row.map((cell, col) =>
              renderCell('td', cell, token.align[col], `${keyPath}-td-${rowIndex}-${col}`))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// Render a marked.lexer() token list as React elements (the streaming path).
export const renderTokens = (tokens, keyPrefix) => {
  if (!tokens) return null;
  return tokens.map((token, index) => renderToken(token, `${keyPrefix}-${index}`));
};
