import { classifyGeneratedFile } from './generated-file-policy';

describe('classifyGeneratedFile', () => {
  it.each([
    ['report.docx', 'docx'],
    ['deck.PPTX', 'pptx'],
    ['budget.xlsx', 'xlsx'],
    ['legacy.xls', 'xls'],
    ['workbook.ods', 'ods'],
    ['export.csv', 'csv'],
  ] as const)('marks %s as download-only', (filename, format) => {
    expect(classifyGeneratedFile({ filename, mimeType: 'application/octet-stream' })).toEqual({
      kind: 'download-only',
      format,
    });
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.ms-excel', 'xls'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
    ['text/csv; charset=utf-8', 'csv'],
  ] as const)('uses MIME for an extensionless file: %s', (mimeType, format) => {
    expect(classifyGeneratedFile({ filename: 'generated-file', mimeType })).toEqual({
      kind: 'download-only',
      format,
    });
  });

  it('lets a known non-Office extension win over a misleading Office MIME', () => {
    expect(
      classifyGeneratedFile({
        filename: 'notes.txt',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toEqual({ kind: 'existing' });
  });

  it.each([
    ['report.pdf', 'application/pdf'],
    ['notes.md', 'text/markdown'],
    ['diagram.png', 'image/png'],
    ['archive.bin', 'application/octet-stream'],
  ])('preserves existing handling for %s', (filename, mimeType) => {
    expect(classifyGeneratedFile({ filename, mimeType })).toEqual({ kind: 'existing' });
  });
});
