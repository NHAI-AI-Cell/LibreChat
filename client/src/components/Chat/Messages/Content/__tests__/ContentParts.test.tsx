import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TMessageContentParts } from 'librechat-data-provider';

jest.mock('~/utils', () => ({
  mapAttachments: () => ({}),
  filterAttachmentsForPart: (attachments: unknown) => attachments,
  groupSequentialToolCalls: (parts: Array<{ part: unknown; idx: number }>) =>
    parts.map((p) => ({ type: 'single' as const, part: p })),
}));

jest.mock('~/Providers', () => ({
  MessageContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
  SearchContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
}));

jest.mock('../Parts', () => ({
  EditTextPart: () => <div data-testid="edit-text-part" />,
  EmptyText: () => <div data-testid="empty-text" />,
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => <div data-testid="memory-artifacts" />,
}));

jest.mock('../Parts/PendingSkillCall', () => ({
  __esModule: true,
  default: ({ skillName, loaded }: { skillName: string; loaded: boolean }) => (
    <div data-testid="pending-skill-call" data-skill={skillName} data-loaded={String(loaded)} />
  ),
}));

jest.mock('../ToolCallGroup', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-call-group" />,
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="container">{children}</div>
  ),
}));

jest.mock('../Files', () => ({
  __esModule: true,
  default: ({ files }: { files?: Array<{ file_id: string; filename?: string }> }) => (
    <>
      {(files ?? []).map((file) => (
        <div key={file.file_id} data-testid="content-file">
          {file.filename}
        </div>
      ))}
    </>
  ),
}));

jest.mock('../Part', () => ({
  __esModule: true,
  default: ({ part }: { part: TMessageContentParts }) => (
    <div data-testid={`real-part-${part.type}`} />
  ),
}));

jest.mock('../ParallelContent', () => ({
  ParallelContentRenderer: () => <div data-testid="parallel-renderer" />,
}));

import ContentParts from '../ContentParts';

const baseProps = {
  messageId: 'msg-1',
  isLast: false,
  isSubmitting: false,
  isLatestMessage: false,
  isCreatedByUser: false,
  content: [],
};

describe('ContentParts — interim skill cards', () => {
  it('renders a PendingSkillCall per manual skill on assistant messages', () => {
    render(<ContentParts {...baseProps} manualSkills={['brand-guidelines', 'pptx']} />);
    const cards = screen.getAllByTestId('pending-skill-call');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-skill', 'brand-guidelines');
    expect(cards[1]).toHaveAttribute('data-skill', 'pptx');
  });

  it('starts pending skill cards in the not-loaded state (no real content yet)', () => {
    render(<ContentParts {...baseProps} manualSkills={['pptx']} />);
    expect(screen.getByTestId('pending-skill-call')).toHaveAttribute('data-loaded', 'false');
  });

  it('flips pending cards to loaded once any real content part arrives', () => {
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'streamed' } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={content} manualSkills={['pptx']} />);
    expect(screen.getByTestId('pending-skill-call')).toHaveAttribute('data-loaded', 'true');
  });

  it('does NOT render skill cards on user messages', () => {
    render(<ContentParts {...baseProps} isCreatedByUser manualSkills={['pptx']} />);
    expect(screen.queryByTestId('pending-skill-call')).toBeNull();
  });

  it('renders nothing when manualSkills is empty and content is undefined', () => {
    const { container } = render(
      <ContentParts {...baseProps} content={undefined} manualSkills={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders pending skill cards even when content is undefined', () => {
    render(<ContentParts {...baseProps} content={undefined} manualSkills={['pptx']} />);
    expect(screen.getAllByTestId('pending-skill-call')).toHaveLength(1);
  });

  it('renders pending skill cards above parallel content', () => {
    const parallelContent: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'parallel',
        groupId: 'group-1',
      } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={parallelContent} manualSkills={['pptx']} />);
    const skillCard = screen.getByTestId('pending-skill-call');
    const parallelRenderer = screen.getByTestId('parallel-renderer');
    expect(skillCard).toBeTruthy();
    expect(parallelRenderer).toBeTruthy();
    expect(skillCard.compareDocumentPosition(parallelRenderer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders pending skill cards above sequential content', () => {
    const sequentialContent: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'streamed' } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={sequentialContent} manualSkills={['pptx']} />);
    const skillCard = screen.getByTestId('pending-skill-call');
    const textPart = screen.getByTestId(`real-part-${ContentTypes.TEXT}`);
    expect(skillCard).toBeTruthy();
    expect(textPart).toBeTruthy();
    expect(skillCard.compareDocumentPosition(textPart)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ContentParts — message files', () => {
  const pdf = {
    file_id: 'f1',
    filename: 'report.pdf',
    filepath: '/uploads/report.pdf',
    type: 'application/pdf',
  };
  const png = {
    file_id: 'f2',
    filename: 'shot.png',
    filepath: '/uploads/shot.png',
    type: 'image/png',
  };

  /** `Container` is only reached by messages with no content at all, so an
   * assistant turn carrying both reasoning and a generated file dropped the
   * file entirely before this slot existed. */
  it('renders a non-image file once alongside content parts', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[{ type: ContentTypes.TEXT, text: 'hi' } as TMessageContentParts]}
        files={[pdf]}
      />,
    );

    expect(screen.getAllByTestId('content-file')).toHaveLength(1);
    expect(screen.getByTestId('content-file')).toHaveTextContent('report.pdf');
  });

  /** Images already render as `image_file` parts; showing them here too would
   * duplicate every generated image in an imported conversation. */
  it('leaves image files to their image_file parts', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[{ type: ContentTypes.TEXT, text: 'hi' } as TMessageContentParts]}
        files={[png]}
      />,
    );

    expect(screen.queryByTestId('content-file')).not.toBeInTheDocument();
  });

  it('renders nothing extra when the message has no files', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[{ type: ContentTypes.TEXT, text: 'hi' } as TMessageContentParts]}
      />,
    );

    expect(screen.queryByTestId('content-file')).not.toBeInTheDocument();
  });

  /** The parallel and edit branches return before the sequential body, so each
   * one has to render the slot itself or it silently drops the file. */
  it('renders the file on the parallel-content path', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[
          { type: ContentTypes.TEXT, text: 'a', groupId: 'g1' } as unknown as TMessageContentParts,
        ]}
        files={[pdf]}
      />,
    );

    expect(screen.getByTestId('parallel-renderer')).toBeInTheDocument();
    expect(screen.getAllByTestId('content-file')).toHaveLength(1);
  });

  it('renders the file exactly once in edit mode, across several editable parts', () => {
    render(
      <ContentParts
        {...baseProps}
        edit
        enterEdit={() => undefined}
        setSiblingIdx={() => undefined}
        siblingIdx={0}
        content={[
          { type: ContentTypes.THINK, think: 'reasoning' } as unknown as TMessageContentParts,
          { type: ContentTypes.TEXT, text: 'answer' } as TMessageContentParts,
        ]}
        files={[pdf]}
      />,
    );

    expect(screen.getAllByTestId('edit-text-part')).toHaveLength(2);
    expect(screen.getAllByTestId('content-file')).toHaveLength(1);
  });
});
