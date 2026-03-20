/**
 * Convert Claude's markdown output to Telegram-compatible HTML.
 *
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a>, <s>, <u>,
 * <blockquote>, and <tg-spoiler>. Everything else must be escaped.
 */

// Escape HTML entities in plain text segments
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
  // Split out code blocks first so we don't mangle their contents
  const parts: string[] = [];
  let cursor = 0;

  // Match fenced code blocks: ```lang?\n...\n```
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(md)) !== null) {
    // Process the text before this code block
    if (match.index > cursor) {
      parts.push(convertInline(md.slice(cursor, match.index)));
    }
    const lang = match[1];
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    parts.push(lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`);
    cursor = match.index + match[0].length;
  }

  // Process remaining text after last code block
  if (cursor < md.length) {
    parts.push(convertInline(md.slice(cursor)));
  }

  return parts.join("");
}

function convertInline(text: string): string {
  // Inline code first (so we don't process markdown inside it)
  const inlineCodeRe = /`([^`]+)`/g;
  const segments: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineCodeRe.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push(convertFormattingAndStructure(text.slice(cursor, match.index)));
    }
    segments.push(`<code>${escapeHtml(match[1])}</code>`);
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push(convertFormattingAndStructure(text.slice(cursor)));
  }

  return segments.join("");
}

function convertFormattingAndStructure(text: string): string {
  let result = escapeHtml(text);

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words with underscores)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Blockquotes: > text (at start of line)
  result = result.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  result = result.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Headers: strip the # markers, make bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "—");

  return result;
}
