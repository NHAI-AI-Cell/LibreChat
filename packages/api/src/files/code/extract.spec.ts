import * as os from 'os';
import * as path from 'path';
import {
  extractCodeArtifactText,
  getExtractedTextFormat,
  resolveMaxTextExtractBytes,
  MAX_TEXT_CACHE_BYTES,
  MAX_TEXT_EXTRACT_BYTES,
} from './extract';

const parseDocumentCalls: Array<{ path: string; originalname: string; mimetype: string }> = [];

jest.mock('~/files/documents/crud', () => ({
  parseDocument: jest.fn(
    async ({ file }: { file: { path: string; originalname: string; mimetype: string } }) => {
      parseDocumentCalls.push(file);
      if (file.originalname.includes('force-failure')) {
        throw new Error('parse failed');
      }
      return { text: '__PARSED__', filename: file.originalname, bytes: 10 };
    },
  ),
}));

describe('extractCodeArtifactText', () => {
  beforeEach(() => {
    parseDocumentCalls.length = 0;
  });

  it('decodes UTF-8 text', async () => {
    await expect(
      extractCodeArtifactText(Buffer.from('hello\n'), 'note.txt', 'text/plain', 'utf8-text'),
    ).resolves.toBe('hello\n');
  });

  it('returns null for binary-looking text', async () => {
    await expect(
      extractCodeArtifactText(
        Buffer.from([0x68, 0x69, 0x00, 0x6f]),
        'fake.txt',
        'text/plain',
        'utf8-text',
      ),
    ).resolves.toBeNull();
  });

  it('returns null above the extraction limit', async () => {
    await expect(
      extractCodeArtifactText(
        Buffer.alloc(MAX_TEXT_EXTRACT_BYTES + 1, 'a'),
        'large.txt',
        'text/plain',
        'utf8-text',
      ),
    ).resolves.toBeNull();
  });

  it('truncates cached text on a UTF-8 boundary', async () => {
    const buffer = Buffer.from('a'.repeat(MAX_TEXT_CACHE_BYTES - 30) + '你'.repeat(50));
    const text = await extractCodeArtifactText(buffer, 'large.txt', 'text/plain', 'utf8-text');
    expect(text?.endsWith('…[truncated]')).toBe(true);
    expect(text).not.toContain('�');
    expect(Buffer.byteLength(text ?? '')).toBeLessThanOrEqual(MAX_TEXT_CACHE_BYTES);
  });

  it.each(['docx', 'pptx', 'xlsx', 'xls', 'ods', 'csv'])(
    'never extracts a generated .%s file',
    async (extension) => {
      const text = await extractCodeArtifactText(
        Buffer.from('content'),
        `generated.${extension}`,
        'application/octet-stream',
        extension === 'pptx' ? 'pptx' : 'document',
      );
      expect(text).toBeNull();
      expect(parseDocumentCalls).toHaveLength(0);
    },
  );

  it('keeps PDF/ODT-style document extraction', async () => {
    await expect(
      extractCodeArtifactText(Buffer.from('PKfake'), 'notes.odt', 'application/zip', 'document'),
    ).resolves.toBe('__PARSED__');
    expect(parseDocumentCalls[0]?.mimetype).toBe('application/vnd.oasis.opendocument.text');
  });

  it('contains temporary document paths inside os.tmpdir()', async () => {
    await extractCodeArtifactText(
      Buffer.from('PKfake'),
      '../../../etc/passwd.odt',
      'application/zip',
      'document',
    );
    const call = parseDocumentCalls[0];
    expect(call).toBeDefined();
    expect(path.resolve(call.path).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(call.originalname).toBe('passwd.odt');
  });

  it('returns null when document parsing fails', async () => {
    await expect(
      extractCodeArtifactText(
        Buffer.from('PKfake'),
        'force-failure.odt',
        'application/zip',
        'document',
      ),
    ).resolves.toBeNull();
  });
});

describe('getExtractedTextFormat', () => {
  it('marks extracted content as text only', () => {
    expect(getExtractedTextFormat('note.txt', 'text/plain', 'hello')).toBe('text');
    expect(getExtractedTextFormat('note.txt', 'text/plain', null)).toBeNull();
  });
});

describe('resolveMaxTextExtractBytes', () => {
  const TWO_MB = 2 * 1024 * 1024;

  it('defaults to 2 MB when unset or blank', () => {
    expect(resolveMaxTextExtractBytes(undefined)).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('   ')).toBe(TWO_MB);
  });

  it('honors a valid positive byte override', () => {
    expect(resolveMaxTextExtractBytes('1048576')).toBe(1048576);
    expect(resolveMaxTextExtractBytes('5242880')).toBe(5242880);
  });

  it('floors fractional values', () => {
    expect(resolveMaxTextExtractBytes('1048576.9')).toBe(1048576);
  });

  it('falls back to the default on non-numeric or non-positive input', () => {
    expect(resolveMaxTextExtractBytes('nope')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('0')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('-100')).toBe(TWO_MB);
  });

  it('falls back to the default for sub-byte values that floor to zero', () => {
    expect(resolveMaxTextExtractBytes('0.5')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('0.999')).toBe(TWO_MB);
  });

  it('wires the exported ceiling through the resolver for the current env', () => {
    /* Asserting a literal 2 MB here would falsely fail when the suite runs
     * with FILE_PREVIEW_MAX_EXTRACT_BYTES set (the export is initialized
     * from the env at module load). Verify the export tracks the resolver
     * instead; the `undefined` case above pins the 2 MB default. */
    expect(MAX_TEXT_EXTRACT_BYTES).toBe(
      resolveMaxTextExtractBytes(process.env.FILE_PREVIEW_MAX_EXTRACT_BYTES),
    );
  });
});
