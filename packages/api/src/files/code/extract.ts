import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { classifyGeneratedFile } from 'librechat-data-provider';
import type { CodeArtifactCategory } from './classify';
import { withTimeout } from '~/utils/promise';
import { parseDocument } from '~/files/documents/crud';
import { isBinaryBuffer } from '~/skills/binary';

export const MAX_TEXT_CACHE_BYTES: number = 512 * 1024;

/** Default inline-preview extraction ceiling: 2 MB. Office/text artifacts
 * larger than this skip inline preview and fall back to download-only. */
const DEFAULT_MAX_TEXT_EXTRACT_BYTES = 2 * 1024 * 1024;

/**
 * Resolve the inline-preview extraction ceiling from
 * `FILE_PREVIEW_MAX_EXTRACT_BYTES`, falling back to the 2 MB default when
 * the value is missing, non-numeric, or non-positive. Raising it lets
 * larger documents render an inline preview; the rendered HTML is still
 * independently capped at {@link MAX_TEXT_CACHE_BYTES} (512 KB), so
 * image-heavy files over that show the "too large" banner instead.
 */
export function resolveMaxTextExtractBytes(value: string | undefined): number {
  if (value == null || value.trim() === '') {
    return DEFAULT_MAX_TEXT_EXTRACT_BYTES;
  }
  /* Floor first, then validate: a fractional value in (0, 1) passes a
   * `> 0` check but floors to 0, which would treat every non-empty
   * artifact as oversized — fall back to the default instead. */
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored) || floored < 1) {
    logger.warn(
      `[extract] Invalid FILE_PREVIEW_MAX_EXTRACT_BYTES "${value}"; using ${DEFAULT_MAX_TEXT_EXTRACT_BYTES} bytes.`,
    );
    return DEFAULT_MAX_TEXT_EXTRACT_BYTES;
  }
  return floored;
}

export const MAX_TEXT_EXTRACT_BYTES: number = resolveMaxTextExtractBytes(
  process.env.FILE_PREVIEW_MAX_EXTRACT_BYTES,
);
const DOCUMENT_PARSE_TIMEOUT_MS = 8_000;
const TRUNCATION_MARKER = '\n\n…[truncated]';
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf-8');

/**
 * Classify the format of a string returned by `extractCodeArtifactText`
 * so callers can persist it alongside the text. Download-only Office
 * files never reach this point; every remaining extract is plain text.
 */
export function getExtractedTextFormat(
  _name: string,
  _mimeType: string,
  text: string | null,
): 'text' | null {
  return text == null ? null : 'text';
}

/**
 * Truncate UTF-8 content to fit within MAX_TEXT_CACHE_BYTES. Walks back to a
 * code-point boundary so the cut never lands inside a multi-byte sequence
 * (which would emit a U+FFFD replacement character — a real concern for CJK
 * and emoji-heavy content). Accepts an optional pre-built buffer to avoid
 * re-encoding when the caller already has one.
 */
const truncate = (text: string, originalBuffer?: Buffer): string => {
  const buffer = originalBuffer ?? Buffer.from(text, 'utf-8');
  if (buffer.length <= MAX_TEXT_CACHE_BYTES) {
    return text;
  }
  let sliceLen = Math.max(0, MAX_TEXT_CACHE_BYTES - TRUNCATION_MARKER_BYTES);
  // UTF-8 continuation bytes match 0b10xxxxxx; keep walking back while the
  // proposed cut would split a sequence.
  while (sliceLen > 0 && (buffer[sliceLen] & 0xc0) === 0x80) {
    sliceLen--;
  }
  return buffer.subarray(0, sliceLen).toString('utf-8') + TRUNCATION_MARKER;
};

const extractUtf8 = (buffer: Buffer): string | null => {
  if (isBinaryBuffer(buffer)) {
    return null;
  }
  if (buffer.length <= MAX_TEXT_CACHE_BYTES) {
    return buffer.toString('utf-8');
  }
  return truncate(buffer.toString('utf-8'), buffer);
};

/**
 * Map ODT back to its canonical MIME when sniffing yields a generic ZIP type.
 */
const documentMimeFromExtension = (name: string): string | null => {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.odt':
      return 'application/vnd.oasis.opendocument.text';
    default:
      return null;
  }
};

const extractDocument = async (
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<string | null> => {
  const canonicalMime = documentMimeFromExtension(name) ?? mimeType;
  const tempPath = path.join(os.tmpdir(), `code-artifact-${randomUUID()}`);
  await fs.writeFile(tempPath, buffer);
  try {
    const result = await withTimeout(
      parseDocument({
        file: {
          path: tempPath,
          size: buffer.length,
          mimetype: canonicalMime,
          originalname: path.basename(name),
        } as Express.Multer.File,
      }),
      DOCUMENT_PARSE_TIMEOUT_MS,
      `parseDocument exceeded ${DOCUMENT_PARSE_TIMEOUT_MS}ms`,
    );
    if (!result?.text) {
      return null;
    }
    return truncate(result.text);
  } finally {
    fs.unlink(tempPath).catch(() => {});
  }
};

/**
 * Extract a string representation of a code-execution artifact for inline
 * rendering. Returns `null` for binary, oversized, or unsupported files; the
 * caller should fall back to the standard download UI in that case.
 *
 * - download-only Office formats: null
 * - utf8-text: decodes the buffer (with a binary safety net)
 * - document: dispatches to the existing PDF/ODT parser
 * - other: returns null (binary file, no inline preview)
 */
export async function extractCodeArtifactText(
  buffer: Buffer,
  name: string,
  mimeType: string,
  category: CodeArtifactCategory,
): Promise<string | null> {
  if (buffer.length > MAX_TEXT_EXTRACT_BYTES) {
    return null;
  }
  if (classifyGeneratedFile({ filename: name, mimeType }).kind === 'download-only') {
    return null;
  }
  try {
    if (category === 'other') {
      return null;
    }
    if (category === 'utf8-text') {
      return extractUtf8(buffer);
    }
    if (category === 'document') {
      return await extractDocument(buffer, name, mimeType);
    }
    return null;
  } catch (error) {
    logger.debug(
      `[extractCodeArtifactText] Failed to extract "${name}" (${mimeType}): ${(error as Error).message}`,
    );
    return null;
  }
}
