import { useMemo, useState, useCallback, memo } from 'react';
import { classifyGeneratedFile } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import FilePreviewDialog, { getFilePreviewKind } from './FilePreviewDialog';
import { useAttachmentLink } from './Parts/LogLink';
import Image from './Image';

const MessageFile = memo(
  ({ file, onPreview }: { file: Partial<TFile>; onPreview: (file: Partial<TFile>) => void }) => {
    const { handleDownload } = useAttachmentLink({
      href: file.filepath ?? '',
      filename: file.filename ?? '',
      file_id: file.file_id,
      user: file.user,
      source: file.source,
    });
    const downloadOnly =
      classifyGeneratedFile({ filename: file.filename, mimeType: file.type }).kind ===
      'download-only';
    const canPreview =
      !downloadOnly && getFilePreviewKind(file.filename ?? '', file.type) !== false;

    return (
      <FileContainer file={file} onClick={canPreview ? () => onPreview(file) : handleDownload} />
    );
  },
);
MessageFile.displayName = 'MessageFile';

const Files = ({ message }: { message?: TMessage }) => {
  const imageFiles = useMemo(() => {
    return message?.files?.filter((file) => file.type?.startsWith('image/')) || [];
  }, [message?.files]);

  const otherFiles = useMemo(() => {
    return message?.files?.filter((file) => !file.type?.startsWith('image/')) || [];
  }, [message?.files]);

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {otherFiles.length > 0 &&
        otherFiles.map((file) => (
          <MessageFile key={file.file_id} file={file} onPreview={setSelectedFile} />
        ))}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            imagePath={file.preview ?? file.filepath ?? ''}
            height={file.height ?? 1920}
            width={file.width ?? 1080}
            altText={file.filename ?? 'Uploaded Image'}
          />
        ))}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSize={(selectedFile as TFile)?.bytes}
      />
    </>
  );
};

export default memo(Files);
