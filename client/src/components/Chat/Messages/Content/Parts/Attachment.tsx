import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Download, ChevronDown, Files as FilesIcon } from 'lucide-react';
import { Tools } from 'librechat-data-provider';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import type { ToolArtifactType } from '~/utils/artifacts';
import {
  artifactTypeForAttachment,
  bySalience,
  byEntrySalience,
  displayFilename,
  isDownloadOnlyAttachment,
  isImageAttachment,
  isInternalSandboxArtifact,
  isTextAttachment,
  renderAttachmentKey,
} from './attachmentTypes';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import FilePreviewDialog, { getFilePreviewKind } from '../FilePreviewDialog';
import { fileToArtifact, TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
import Image from '~/components/Chat/Messages/Content/Image';
import ToolMermaidArtifact from './ToolMermaidArtifact';
import ToolArtifactCard from './ToolArtifactCard';
import { useAttachmentLink } from './LogLink';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { cn } from '~/utils';

const COLLAPSED_MAX_HEIGHT = 320;

const FileAttachment = memo(({ attachment }: { attachment: Partial<TAttachment> }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const file = attachment as TFile & TAttachmentMetadata;
  const { handleDownload } = useAttachmentLink({
    href: attachment.filepath ?? '',
    filename: attachment.filename ?? '',
    file_id: file.file_id,
    user: file.user,
    source: file.source,
  });
  const extension = attachment.filename?.split('.').pop();
  const canPreview =
    !isDownloadOnlyAttachment(attachment) &&
    Boolean(file.file_id) &&
    getFilePreviewKind(attachment.filename ?? '', attachment.type) !== false;

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  if (!attachment.filepath) {
    return null;
  }
  return (
    <div
      className={cn(
        'file-attachment-container',
        'transition-all duration-300 ease-out',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
      style={{
        transformOrigin: 'center top',
        willChange: 'opacity, transform',
        WebkitFontSmoothing: 'subpixel-antialiased',
      }}
    >
      <FileContainer
        file={attachment}
        onClick={canPreview ? () => setPreviewOpen(true) : handleDownload}
        overrideType={extension}
        displayName={displayFilename(attachment.filename)}
        containerClassName="max-w-fit"
        buttonClassName="bg-surface-secondary hover:cursor-pointer hover:bg-surface-hover active:bg-surface-secondary focus:bg-surface-hover hover:border-border-heavy active:border-border-heavy"
      />
      {canPreview && previewOpen && (
        <FilePreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          fileName={attachment.filename ?? ''}
          fileId={file.file_id}
          filePath={attachment.filepath}
          fileType={attachment.type}
          fileSize={file.bytes}
        />
      )}
    </div>
  );
});

const FileAttachmentGroup = memo(({ attachments }: { attachments: TAttachment[] }) => {
  const localize = useLocalize();
  const panelId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const visibleAttachments = useMemo(
    () => attachments.filter((attachment) => Boolean(attachment.filepath)),
    [attachments],
  );
  const count = visibleAttachments.length;
  const summary = useMemo(() => {
    const names = visibleAttachments.map((attachment) => displayFilename(attachment.filename));
    if (names.length <= 2) {
      return names.join(', ');
    }
    return `${names.slice(0, 2).join(', ')} ${localize('com_ui_plus_n_more', {
      0: String(names.length - 2),
    })}`;
  }, [visibleAttachments, localize]);
  const groupedAttachments = useMemo(() => {
    const files: TAttachment[] = [];
    const textPreviews: TAttachment[] = [];
    for (const attachment of visibleAttachments) {
      if (isDownloadOnlyAttachment(attachment)) {
        files.push(attachment);
        continue;
      }
      if (isTextAttachment(attachment)) {
        textPreviews.push(attachment);
        continue;
      }
      files.push(attachment);
    }
    return { files, textPreviews };
  }, [visibleAttachments]);

  if (count === 0) {
    return null;
  }

  if (count === 1) {
    const [attachment] = visibleAttachments;
    if (!attachment) {
      return null;
    }
    return (
      <div className="my-2 flex flex-wrap items-center gap-2.5">
        <FileAttachment attachment={attachment} key={renderAttachmentKey('file', attachment, 0)} />
      </div>
    );
  }

  const fileCount = localize('com_ui_n_files', { 0: String(count) });
  const buttonLabel = isExpanded
    ? localize('com_ui_hide_n_files', { 0: String(count) })
    : localize('com_ui_show_n_files', { 0: String(count) });

  return (
    <div className="my-2 w-full max-w-full">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-label={buttonLabel}
        onClick={() => setIsExpanded((prev) => !prev)}
        className={cn(
          'inline-flex w-full max-w-full items-center gap-2 rounded-lg py-1 pr-2 text-sm',
          'text-text-secondary transition-colors hover:text-text-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
        )}
      >
        <FilesIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">{fileCount}</span>
        {summary.length > 0 && (
          <span className="min-w-0 truncate text-left text-xs font-normal" title={summary}>
            {'— '}
            {summary}
          </span>
        )}
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 transition-transform duration-200 ease-out',
            isExpanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>
      <div id={panelId} style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef} aria-hidden={!isExpanded}>
          <div className="flex flex-col gap-2.5 pt-2">
            {groupedAttachments.files.length > 0 && (
              <div className="flex flex-wrap items-center gap-2.5">
                {groupedAttachments.files.map((attachment, index) => (
                  <FileAttachment
                    attachment={attachment}
                    key={renderAttachmentKey('file', attachment, index)}
                  />
                ))}
              </div>
            )}
            {groupedAttachments.textPreviews.map((attachment, index) => (
              <TextAttachment
                attachment={attachment}
                showFileChip={false}
                key={renderAttachmentKey('text', attachment, index)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
FileAttachmentGroup.displayName = 'FileAttachmentGroup';

const TextAttachment = memo(
  ({
    attachment,
    showFileChip = true,
  }: {
    attachment: Partial<TAttachment>;
    showFileChip?: boolean;
  }) => {
    const localize = useLocalize();
    const preId = useId();
    const preRef = useRef<HTMLPreElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [expanded, setExpanded] = useState(false);
    // Decided once after layout: does the text actually overflow the collapsed
    // height? Char count is a poor proxy (a 100-char file with many newlines can
    // overflow; 800 chars of dense single-line text may not), so we measure.
    const [overflowed, setOverflowed] = useState(false);
    const file = attachment as TFile & TAttachmentMetadata;
    const { handleDownload } = useAttachmentLink({
      href: attachment.filepath ?? '',
      filename: attachment.filename ?? '',
      file_id: file.file_id,
      user: file.user,
      source: file.source,
    });
    const extension = attachment.filename?.split('.').pop();
    const text = file.text ?? '';
    const visibleFilename = displayFilename(attachment.filename);

    useEffect(() => {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }, []);

    useLayoutEffect(() => {
      const el = preRef.current;
      if (!el) {
        return;
      }
      setOverflowed(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1);
    }, [text]);

    const isClamped = overflowed && !expanded;

    return (
      <div
        className={cn(
          'text-attachment-container flex w-full flex-col gap-1.5',
          'transition-all duration-300 ease-out',
          isVisible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        )}
        style={{
          transformOrigin: 'center top',
          willChange: 'opacity, transform',
          WebkitFontSmoothing: 'subpixel-antialiased',
        }}
      >
        {attachment.filepath && showFileChip && (
          <FileContainer
            file={attachment}
            onClick={handleDownload}
            overrideType={extension}
            displayName={displayFilename(attachment.filename)}
            containerClassName="max-w-fit"
            buttonClassName="bg-surface-secondary hover:cursor-pointer hover:bg-surface-hover active:bg-surface-secondary focus:bg-surface-hover hover:border-border-heavy active:border-border-heavy"
          />
        )}
        <div className="overflow-hidden rounded-lg bg-surface-secondary">
          {!showFileChip && (
            <div className="flex items-center justify-between gap-2 border-b border-border-light px-3 py-2">
              <span className="min-w-0 truncate text-sm font-medium" title={visibleFilename}>
                {visibleFilename}
              </span>
              {attachment.filepath && (
                <button
                  type="button"
                  onClick={handleDownload}
                  aria-label={`${localize('com_ui_download')} ${visibleFilename}`}
                  title={localize('com_ui_download')}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                >
                  <Download className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <div className="p-4">
            <pre
              id={preId}
              ref={preRef}
              className={cn(
                'whitespace-pre-wrap break-words font-mono text-sm leading-6 text-text-primary',
                isClamped ? 'overflow-hidden' : 'overflow-auto',
              )}
              style={isClamped ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
            >
              {text}
            </pre>
            {overflowed && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-controls={preId}
                className="mt-2 text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
              >
                {expanded ? localize('com_ui_collapse') : localize('com_ui_show_all')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

const ImageAttachment = memo(({ attachment }: { attachment: TAttachment }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const { width, height, filepath = null } = attachment as TFile & TAttachmentMetadata;

  useEffect(() => {
    setIsLoaded(false);
    const timer = setTimeout(() => setIsLoaded(true), 100);
    return () => clearTimeout(timer);
  }, [attachment]);

  return (
    <div
      className={cn(
        'image-attachment-container',
        'transition-all duration-500 ease-out',
        isLoaded ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0',
      )}
      style={{
        transformOrigin: 'center top',
        willChange: 'opacity, transform',
        WebkitFontSmoothing: 'subpixel-antialiased',
      }}
    >
      <Image
        altText={attachment.filename || 'attachment image'}
        imagePath={filepath ?? ''}
        width={width}
        height={height}
        className="mb-4"
      />
    </div>
  );
});

interface PanelArtifactProps {
  attachment: TAttachment;
  /** Pre-classified type from the routing decision tree, threaded down so
   * `fileToArtifact` doesn't re-run `detectArtifactTypeFromFile`. */
  type: ToolArtifactType;
}

const PanelArtifact = memo(({ attachment, type }: PanelArtifactProps) => {
  const localize = useLocalize();
  const placeholder = localize('com_ui_artifact_preview_pending');
  const artifact = useMemo(
    () =>
      fileToArtifact(attachment as TFile & TAttachmentMetadata, {
        placeholder,
        preClassifiedType: type,
      }),
    [attachment, type, placeholder],
  );
  if (!artifact) {
    return null;
  }
  return <ToolArtifactCard attachment={attachment} artifact={artifact} />;
});
PanelArtifact.displayName = 'PanelArtifact';

const MermaidArtifact = memo(({ attachment }: { attachment: TAttachment }) => {
  const file = attachment as TFile & TAttachmentMetadata;
  if (!file.text) {
    return null;
  }
  return <ToolMermaidArtifact attachment={attachment} text={file.text} />;
});
MermaidArtifact.displayName = 'MermaidArtifact';

export default function Attachment({ attachment }: { attachment?: TAttachment }) {
  if (!attachment) {
    return null;
  }
  if (attachment.type === Tools.web_search) {
    return null;
  }
  // Sandbox-internal placeholders (`.dirkeep` etc.) are an implementation
  // detail of the bash executor's empty-folder preservation; users have
  // no reason to see them as their own file chips.
  if (isInternalSandboxArtifact(attachment)) {
    return null;
  }

  if (isImageAttachment(attachment)) {
    return <ImageAttachment attachment={attachment} />;
  }
  if (isDownloadOnlyAttachment(attachment)) {
    return attachment.filepath ? <FileAttachment attachment={attachment} /> : null;
  }
  // Single classification call. The result is threaded into
  // `PanelArtifact` -> `fileToArtifact` so the panel path doesn't
  // re-run `detectArtifactTypeFromFile` a second time.
  const artType = artifactTypeForAttachment(attachment);
  if (artType === TOOL_ARTIFACT_TYPES.MERMAID) {
    return <MermaidArtifact attachment={attachment} />;
  }
  if (artType != null) {
    return <PanelArtifact attachment={attachment} type={artType} />;
  }
  if (isTextAttachment(attachment)) {
    return <TextAttachment attachment={attachment} />;
  }
  if (!attachment.filepath) {
    return null;
  }
  return <FileAttachment attachment={attachment} />;
}

export function AttachmentGroup({ attachments }: { attachments?: TAttachment[] }) {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const fileAttachments: TAttachment[] = [];
  const imageAttachments: TAttachment[] = [];
  const textAttachments: TAttachment[] = [];
  const panelRow: Array<{ attachment: TAttachment; type: ToolArtifactType }> = [];
  const mermaidArtifacts: TAttachment[] = [];

  attachments.forEach((attachment) => {
    if (attachment.type === Tools.web_search) {
      return;
    }
    if (isInternalSandboxArtifact(attachment)) {
      return;
    }
    if (isImageAttachment(attachment)) {
      imageAttachments.push(attachment);
      return;
    }
    if (isDownloadOnlyAttachment(attachment)) {
      fileAttachments.push(attachment);
      return;
    }
    const artType = artifactTypeForAttachment(attachment);
    if (artType === TOOL_ARTIFACT_TYPES.MERMAID) {
      mermaidArtifacts.push(attachment);
      return;
    }
    if (artType != null) {
      panelRow.push({ attachment, type: artType });
      return;
    }
    if (isTextAttachment(attachment)) {
      textAttachments.push(attachment);
      return;
    }
    fileAttachments.push(attachment);
  });

  // Sink empty / placeholder-shaped files in each bucket so the user's
  // eye lands on the real artifact first. `sort` is stable in modern
  // engines (V8 ≥ 7.0) so equal-weight entries keep their input order.
  fileAttachments.sort(bySalience);
  textAttachments.sort(bySalience);
  panelRow.sort(byEntrySalience);
  mermaidArtifacts.sort(bySalience);
  imageAttachments.sort(bySalience);

  const downloadableFileAttachments = fileAttachments.filter((attachment) =>
    Boolean(attachment.filepath),
  );
  const downloadableTextAttachments = textAttachments.filter((attachment) =>
    Boolean(attachment.filepath),
  );
  const textOnlyAttachments = textAttachments.filter((attachment) => !attachment.filepath);
  const groupDownloadableFiles =
    downloadableFileAttachments.length + downloadableTextAttachments.length > 1;
  const groupedFileAttachments = groupDownloadableFiles
    ? [...downloadableFileAttachments, ...downloadableTextAttachments].sort(bySalience)
    : downloadableFileAttachments;
  const visibleTextAttachments = groupDownloadableFiles ? textOnlyAttachments : textAttachments;

  return (
    <>
      {groupedFileAttachments.length > 0 && (
        <FileAttachmentGroup attachments={groupedFileAttachments} />
      )}
      {panelRow.length > 0 && (
        <div className="my-2 flex flex-wrap items-center gap-2">
          {panelRow.map(({ attachment, type }, index) => (
            <PanelArtifact
              attachment={attachment}
              type={type}
              key={renderAttachmentKey('artifact', attachment, index)}
            />
          ))}
        </div>
      )}
      {mermaidArtifacts.length > 0 && (
        <div className="my-2 flex flex-col gap-3">
          {mermaidArtifacts.map((attachment, index) => (
            <MermaidArtifact
              attachment={attachment}
              key={renderAttachmentKey('mermaid', attachment, index)}
            />
          ))}
        </div>
      )}
      {visibleTextAttachments.length > 0 && (
        <div className="my-2 flex flex-col gap-3">
          {visibleTextAttachments.map((attachment, index) => (
            <TextAttachment
              attachment={attachment}
              key={renderAttachmentKey('text', attachment, index)}
            />
          ))}
        </div>
      )}
      {imageAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center">
          {imageAttachments.map((attachment, index) => (
            <ImageAttachment
              attachment={attachment}
              key={renderAttachmentKey('image', attachment, index)}
            />
          ))}
        </div>
      )}
    </>
  );
}
