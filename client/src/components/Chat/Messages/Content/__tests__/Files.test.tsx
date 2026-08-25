import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TFile, TMessage } from 'librechat-data-provider';
import Files from '../Files';

const mockDownload = jest.fn();

jest.mock('../Parts/LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: mockDownload }),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, onClick }: { file: Partial<TFile>; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {file.filename}
    </button>
  ),
}));

jest.mock('../FilePreviewDialog', () => {
  const actual = jest.requireActual('../FilePreviewDialog');
  return {
    __esModule: true,
    ...actual,
    default: ({ open, fileName }: { open: boolean; fileName: string }) =>
      open ? <div data-testid="preview-dialog">{fileName}</div> : null,
  };
});

jest.mock('../Image', () => ({
  __esModule: true,
  default: () => <div data-testid="image" />,
}));

const messageWith = (file: Partial<TFile>): TMessage =>
  ({
    messageId: 'message-1',
    files: [file],
  }) as TMessage;

describe('Files', () => {
  beforeEach(() => {
    mockDownload.mockClear();
  });

  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['export.csv', 'text/csv'],
  ])('downloads %s directly instead of opening the preview dialog', (filename, type) => {
    render(
      <Files
        message={messageWith({
          file_id: `file-${filename}`,
          filename,
          filepath: `/files/${filename}`,
          type,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: filename }));

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('preview-dialog')).not.toBeInTheDocument();
  });

  it('keeps PDF preview behavior', () => {
    render(
      <Files
        message={messageWith({
          file_id: 'file-pdf',
          filename: 'report.pdf',
          filepath: '/files/report.pdf',
          type: 'application/pdf',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'report.pdf' }));

    expect(mockDownload).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview-dialog')).toHaveTextContent('report.pdf');
  });

  it('downloads an unsupported archive instead of opening an unavailable preview', () => {
    render(
      <Files
        message={messageWith({
          file_id: 'file-zip',
          filename: 'archive.zip',
          filepath: '/files/archive.zip',
          type: 'application/zip',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'archive.zip' }));

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('preview-dialog')).not.toBeInTheDocument();
  });
});
