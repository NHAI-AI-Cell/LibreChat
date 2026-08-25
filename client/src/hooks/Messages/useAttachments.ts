import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import type { TAttachment, TFile } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';
import store from '~/store';

export default function useAttachments({
  messageId,
  attachments,
}: {
  messageId?: string;
  attachments?: TAttachment[];
}) {
  const messageAttachmentsMap = useRecoilValue(store.messageAttachmentsMap);
  const messageAttachments = useMemo<TAttachment[]>(() => {
    const live = messageAttachmentsMap[messageId ?? ''];
    if (!attachments || attachments.length === 0) {
      return live ?? [];
    }
    if (!live || live.length === 0) {
      return attachments;
    }
    /* DB-loaded attachments decide membership; live SSE entries may
     * carry fresher file metadata for the same `file_id`. */
    const liveByFileId = new Map<string, TAttachment>();
    for (const a of live) {
      const id = (a as Partial<TFile>).file_id;
      if (id) {
        liveByFileId.set(id, a);
      }
    }
    return attachments.map((db) => {
      const id = (db as Partial<TFile>).file_id;
      if (!id) {
        return db;
      }
      const liveEntry = liveByFileId.get(id);
      return liveEntry ? ({ ...db, ...liveEntry } as TAttachment) : db;
    });
  }, [attachments, messageAttachmentsMap, messageId]);

  const searchResults = useSearchResultsByTurn(messageAttachments);

  return {
    attachments: messageAttachments,
    searchResults,
  };
}
