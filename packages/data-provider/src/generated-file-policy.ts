export type DownloadOnlyGeneratedFileFormat = 'docx' | 'pptx' | 'xlsx' | 'xls' | 'ods' | 'csv';

export type GeneratedFilePolicy =
  | { readonly kind: 'download-only'; readonly format: DownloadOnlyGeneratedFileFormat }
  | { readonly kind: 'existing' };

const DOWNLOAD_ONLY_EXTENSIONS: Readonly<Record<string, DownloadOnlyGeneratedFileFormat>> = {
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  xls: 'xls',
  ods: 'ods',
  csv: 'csv',
};

const DOWNLOAD_ONLY_MIME_TYPES: Readonly<Record<string, DownloadOnlyGeneratedFileFormat>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/msexcel': 'xls',
  'application/x-msexcel': 'xls',
  'application/x-ms-excel': 'xls',
  'application/x-excel': 'xls',
  'application/x-dos_ms_excel': 'xls',
  'application/xls': 'xls',
  'application/x-xls': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/comma-separated-values': 'csv',
};

const basename = (filename: string): string => {
  const separator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  return separator < 0 ? filename : filename.slice(separator + 1);
};

const extension = (filename: string): string => {
  const name = basename(filename);
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
};

const baseMime = (mimeType: string): string => {
  const semicolon = mimeType.indexOf(';');
  return (semicolon < 0 ? mimeType : mimeType.slice(0, semicolon)).trim().toLowerCase();
};

/**
 * Classifies the generated file formats whose original bytes are the only
 * reliable representation. A recognized extension wins; MIME is considered
 * only for genuinely extensionless tool outputs.
 */
export function classifyGeneratedFile({
  filename = '',
  mimeType = '',
}: {
  filename?: string;
  mimeType?: string;
}): GeneratedFilePolicy {
  const ext = extension(filename);
  if (ext) {
    const format = DOWNLOAD_ONLY_EXTENSIONS[ext];
    return format ? { kind: 'download-only', format } : { kind: 'existing' };
  }

  const format = DOWNLOAD_ONLY_MIME_TYPES[baseMime(mimeType)];
  return format ? { kind: 'download-only', format } : { kind: 'existing' };
}
