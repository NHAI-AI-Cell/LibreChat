import React from 'react';
import { Tools } from 'librechat-data-provider';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import type {
  EventSubmission,
  TAttachment,
  TAttachmentMetadata,
  TFile,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useAttachmentHandler from '../useAttachmentHandler';
import store from '~/store';

type AttachmentFixture = TFile & TAttachmentMetadata;

const wrapper = ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>;
const submission = {} as EventSubmission;
const messageId = 'message-1';

const makeAttachment = (overrides: Partial<AttachmentFixture> = {}): AttachmentFixture => ({
  user: 'user-1',
  object: 'file',
  bytes: 100,
  embedded: false,
  usage: 0,
  file_id: 'file-1',
  filename: 'report.txt',
  filepath: '/api/files/download/user-1/file-1',
  type: Tools.execute_code,
  messageId,
  toolCallId: 'tool-1',
  ...overrides,
});

function setup() {
  const attachmentsRef: { current: Record<string, TAttachment[] | undefined> } = { current: {} };
  const { result } = renderHook(
    () => {
      const handler = useAttachmentHandler();
      attachmentsRef.current = useRecoilValue(store.messageAttachmentsMap);
      return handler;
    },
    { wrapper },
  );

  return {
    handle(data: TAttachment) {
      act(() => result.current({ data, submission }));
    },
    get attachments(): TAttachment[] {
      return attachmentsRef.current[messageId] ?? [];
    },
  };
}

describe('useAttachmentHandler', () => {
  it('appends a new stored-file attachment', () => {
    const context = setup();
    context.handle(makeAttachment());
    expect(context.attachments).toHaveLength(1);
    expect(context.attachments[0]).toMatchObject({ file_id: 'file-1' });
  });

  it('updates a repeated file_id in place', () => {
    const context = setup();
    context.handle(makeAttachment({ bytes: 100, text: 'old' }));
    context.handle(makeAttachment({ bytes: 200, text: 'new' }));

    expect(context.attachments).toHaveLength(1);
    expect(context.attachments[0]).toMatchObject({ file_id: 'file-1', bytes: 200, text: 'new' });
  });

  it('preserves existing fields omitted by an update event', () => {
    const context = setup();
    context.handle(makeAttachment({ filename: 'original.txt' }));
    context.handle({ file_id: 'file-1', messageId, bytes: 300 } as unknown as TAttachment);

    expect(context.attachments[0]).toMatchObject({ filename: 'original.txt', bytes: 300 });
  });

  it('keeps distinct file ids as separate attachments', () => {
    const context = setup();
    context.handle(makeAttachment({ file_id: 'file-a' }));
    context.handle(makeAttachment({ file_id: 'file-b' }));
    expect(context.attachments).toHaveLength(2);
  });

  it('appends lightweight attachments that have no file_id', () => {
    const context = setup();
    const citation = { messageId, type: Tools.web_search } as unknown as TAttachment;
    context.handle(citation);
    context.handle(citation);
    expect(context.attachments).toHaveLength(2);
  });
});
