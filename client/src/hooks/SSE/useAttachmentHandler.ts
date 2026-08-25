import { useSetRecoilState } from 'recoil';
import type { QueryClient } from '@tanstack/react-query';
import { QueryKeys, Tools } from 'librechat-data-provider';
import type {
  MemoriesResponse,
  EventSubmission,
  TAttachment,
  TFile,
} from 'librechat-data-provider';
import { handleMemoryArtifact } from '~/utils/memory';
import store from '~/store';

export default function useAttachmentHandler(queryClient?: QueryClient) {
  const setAttachmentsMap = useSetRecoilState(store.messageAttachmentsMap);

  return ({ data }: { data: TAttachment; submission: EventSubmission }) => {
    const { messageId } = data;
    const fileId = (data as Partial<TFile>).file_id;

    const fileData = data as TFile;
    if (
      queryClient &&
      fileData?.file_id &&
      fileData?.filepath &&
      !fileData.filepath.includes('/api/files')
    ) {
      queryClient.setQueryData([QueryKeys.files], (oldData: TFile[] | undefined) => {
        if (!oldData) {
          return [fileData];
        }
        const existingIndex = oldData.findIndex((file) => file.file_id === fileData.file_id);
        if (existingIndex > -1) {
          const updated = [...oldData];
          updated[existingIndex] = { ...oldData[existingIndex], ...fileData };
          return updated;
        }
        return [fileData, ...oldData];
      });
    }

    if (queryClient && data.type === Tools.memory && data[Tools.memory]) {
      const memoryArtifact = data[Tools.memory];

      queryClient.setQueryData([QueryKeys.memories], (oldData: MemoriesResponse | undefined) => {
        if (!oldData) {
          return oldData;
        }

        return handleMemoryArtifact({ memoryArtifact, currentData: oldData }) || oldData;
      });
    }

    setAttachmentsMap((prevMap) => {
      const messageAttachments =
        (prevMap as Record<string, TAttachment[] | undefined>)[messageId] || [];
      /* Repeated events for the same stored file update the existing
       * attachment, while lightweight attachments without `file_id`
       * retain append-only behavior. */
      if (fileId) {
        const existingIndex = messageAttachments.findIndex(
          (a) => (a as Partial<TFile>).file_id === fileId,
        );
        if (existingIndex > -1) {
          const merged = [...messageAttachments];
          merged[existingIndex] = { ...messageAttachments[existingIndex], ...data } as TAttachment;
          return { ...prevMap, [messageId]: merged };
        }
      }
      return {
        ...prevMap,
        [messageId]: [...messageAttachments, data],
      };
    });
  };
}
