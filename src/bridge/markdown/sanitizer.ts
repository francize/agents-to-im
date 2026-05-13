/**
 * Assistant markdown sanitizer for outbound Feishu/Lark delivery.
 *
 * Runs after parseMode preprocessing but before card/post rendering. Acts as
 * the last defensive layer between LLM output and the IM API:
 *   - Dangerous link protocols (javascript:, data:text/html, vbscript:, file:)
 *     are replaced with about:blank while preserving the visible label.
 *   - Leaked raw HTML blocks (<script>, <style>, <iframe>, <think>) are stripped.
 *     markdown-it is configured with html:false upstream, but Claude can still
 *     stream raw HTML inline; this is the belt-and-suspenders.
 *   - Markdown tables with mismatched column counts get their separator and
 *     short rows padded so Feishu's renderer doesn't drop the block.
 *   - Content exceeding the byte limit is truncated on a UTF-8 codepoint
 *     boundary with a trailing ellipsis marker.
 */

const DEFAULT_BYTE_LIMIT = 24 * 1024;
const TRUNCATION_MARKER = '\n\n_…内容过长已截断_';

export interface SanitizeOptions {
  byteLimit?: number;
}

export interface SanitizeResult {
  text: string;
  truncated: boolean;
}

export function sanitizeAssistantMarkdown(
  text: string,
  opts: SanitizeOptions = {},
): SanitizeResult {
  if (!text) return { text: '', truncated: false };
  let out = text;
  out = stripDangerousHtml(out);
  out = neutralizeDangerousLinks(out);
  out = fixUnbalancedTables(out);
  const byteLimit = opts.byteLimit ?? DEFAULT_BYTE_LIMIT;
  const { text: clamped, truncated } = truncateByUtf8Bytes(out, byteLimit);
  return { text: clamped, truncated };
}

const DANGEROUS_TAG_BLOCKS = ['script', 'style', 'iframe', 'object', 'embed'];

function stripDangerousHtml(text: string): string {
  let out = text;
  for (const tag of DANGEROUS_TAG_BLOCKS) {
    const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(blockRe, '');
    const selfClose = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(selfClose, '');
  }
  out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<\/?think\b[^>]*>/gi, '');
  return out;
}

const DANGEROUS_PROTOCOL_RE = /^\s*(javascript|vbscript|data\s*:\s*text\s*\/\s*html|file)\b/i;

function isDangerousHref(href: string): boolean {
  return DANGEROUS_PROTOCOL_RE.test(href);
}

function neutralizeDangerousLinks(text: string): string {
  let out = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    return isDangerousHref(href) ? `[${label}](about:blank)` : `[${label}](${href})`;
  });
  out = out.replace(/<([^>\s]+)>/g, (match, inner: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(inner) && isDangerousHref(inner)) {
      return '<about:blank>';
    }
    return match;
  });
  return out;
}

interface TableBlock {
  startLine: number;
  endLine: number;
  lines: string[];
}

function fixUnbalancedTables(text: string): string {
  const lines = text.split('\n');
  const blocks = findTableBlocks(lines);
  if (blocks.length === 0) return text;
  for (const block of blocks) {
    fixTableBlock(lines, block);
  }
  return lines.join('\n');
}

function findTableBlocks(lines: string[]): TableBlock[] {
  const blocks: TableBlock[] = [];
  let i = 0;
  while (i < lines.length - 1) {
    if (isTableRow(lines[i]) && isTableSeparator(lines[i + 1])) {
      const start = i;
      let end = i + 1;
      while (end + 1 < lines.length && isTableRow(lines[end + 1])) {
        end += 1;
      }
      blocks.push({ startLine: start, endLine: end, lines: lines.slice(start, end + 1) });
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return blocks;
}

function isTableRow(line: string | undefined): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

function isTableSeparator(line: string | undefined): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(trimmed);
}

function splitRowCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|');
}

function rebuildRow(cells: string[]): string {
  return `| ${cells.map((c) => c.trim()).join(' | ')} |`;
}

function fixTableBlock(lines: string[], block: TableBlock): void {
  const headerCells = splitRowCells(lines[block.startLine]);
  const headerCols = headerCells.length;
  const sepCells = splitRowCells(lines[block.startLine + 1]);
  if (sepCells.length !== headerCols) {
    const padded: string[] = [];
    for (let i = 0; i < headerCols; i += 1) {
      padded.push(sepCells[i]?.trim() || '---');
    }
    lines[block.startLine + 1] = rebuildRow(padded);
  }
  for (let row = block.startLine + 2; row <= block.endLine; row += 1) {
    const cells = splitRowCells(lines[row]);
    if (cells.length < headerCols) {
      while (cells.length < headerCols) cells.push('');
      lines[row] = rebuildRow(cells);
    } else if (cells.length > headerCols) {
      lines[row] = rebuildRow(cells.slice(0, headerCols));
    }
  }
}

function truncateByUtf8Bytes(text: string, byteLimit: number): SanitizeResult {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= byteLimit) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const budget = Math.max(0, byteLimit - markerBytes);
  let cut = budget;
  while (cut > 0 && (buf[cut] & 0b1100_0000) === 0b1000_0000) {
    cut -= 1;
  }
  const safeSlice = buf.subarray(0, cut).toString('utf8');
  return { text: `${safeSlice}${TRUNCATION_MARKER}`, truncated: true };
}
