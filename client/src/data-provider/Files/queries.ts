import { useRecoilValue } from 'recoil';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSources, QueryKeys, DynamicQueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import { isEphemeralAgent } from '~/common';
import { addFileToCache } from '~/utils';
import store from '~/store';

export const useGetFiles = <TData = t.TFile[] | boolean>(
  config?: UseQueryOptions<t.TFile[], unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TFile[], unknown, TData>([QueryKeys.files], () => dataService.getFiles(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

export const useGetAgentFiles = <TData = t.TFile[]>(
  agentId: string | undefined,
  config?: UseQueryOptions<t.TFile[], unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TFile[], unknown, TData>(
    DynamicQueryKeys.agentFiles(agentId ?? ''),
    () => (agentId ? dataService.getAgentFiles(agentId) : Promise.resolve([])),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled && !isEphemeralAgent(agentId),
    },
  );
};

export const useGetFileConfig = <TData = t.TFileConfig>(
  config?: UseQueryOptions<t.TFileConfig, unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  return useQuery<t.TFileConfig, unknown, TData>(
    [QueryKeys.fileConfig],
    () => dataService.getFileConfig(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

type FileDownloadOptions = {
  source?: string | null;
  direct?: boolean;
};

export const isDirectDownloadSource = (source?: string | null): boolean =>
  source === FileSources.s3 || source === FileSources.cloudfront;

export const revokeDownloadURL = (url?: string | null): void => {
  if (!url?.startsWith('blob:')) {
    return;
  }
  window.URL.revokeObjectURL(url);
};

export const useFileDownload = (
  userId?: string,
  file_id?: string,
  options: FileDownloadOptions = {},
): QueryObserverResult<string> => {
  const queryClient = useQueryClient();
  return useQuery(
    [QueryKeys.fileDownload, file_id, options.source ?? '', options.direct ?? true],
    async () => {
      if (!userId || !file_id) {
        console.warn('No user ID provided for file download');
        return;
      }
      if ((options.direct ?? true) && isDirectDownloadSource(options.source)) {
        try {
          const directDownload = await dataService.getFileDownloadURL(userId, file_id);
          if (directDownload.url) {
            return directDownload.url;
          }
        } catch {
          // Fall back to the legacy proxied download for direct URL failures.
        }
      }

      const response = await dataService.getFileDownload(userId, file_id);
      const blob = response.data;
      const downloadURL = window.URL.createObjectURL(blob);
      try {
        const metadata: t.TFile | undefined = JSON.parse(
          decodeURIComponent(response.headers['x-file-metadata']),
        );
        if (!metadata) {
          console.warn('No metadata found for file download', response.headers);
          return downloadURL;
        }

        addFileToCache(queryClient, metadata);
      } catch (e) {
        console.error('Error parsing file metadata, skipped updating file query cache', e);
      }

      return downloadURL;
    },
    {
      enabled: false,
      retry: false,
    },
  );
};

/**
 * Blob download for a snapshotted file served through a shared link. Authorized
 * by shared-link view permission (public/ACL) rather than the owner's file ACL.
 * Idle by default; call `refetch` to download.
 */
export const useSharedFileDownload = (
  shareId?: string,
  file_id?: string,
): QueryObserverResult<string> => {
  return useQuery(
    [QueryKeys.fileDownload, 'share', shareId ?? '', file_id ?? ''],
    async () => {
      if (!shareId || !file_id) {
        return;
      }
      const response = await dataService.getSharedFileDownload(shareId, file_id);
      return window.URL.createObjectURL(response.data);
    },
    {
      enabled: false,
      retry: false,
    },
  );
};

export const useCodeOutputDownload = (url = ''): QueryObserverResult<string> => {
  return useQuery(
    [QueryKeys.fileDownload, url],
    async () => {
      if (!url) {
        console.warn('No user ID provided for file download');
        return;
      }
      const response = await dataService.getCodeOutputDownload(url);
      const blob = response.data;
      const downloadURL = window.URL.createObjectURL(blob);
      return downloadURL;
    },
    {
      enabled: false,
      retry: false,
    },
  );
};
