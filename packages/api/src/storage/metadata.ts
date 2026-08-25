import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { SaveURLResult } from './types';
import { extractKeyFromS3Url, getStorageMetadataForKey, resolveStoredS3Key } from './s3/crud';

type StorageMetadataInput = {
  filepath?: string | null;
  source?: string | null;
  storageKey?: string | null;
  storageRegion?: string | null;
};

export type StoredObjectRef = Readonly<{
  identity: string;
  streamPath: string;
}>;

const stripTransportSuffix = (value: string): string => value.split(/[?#]/, 1)[0];

/**
 * Resolves the exact stored object named by a file record. The identity is
 * stable across signed-URL refreshes, while streamPath matches the locator the
 * storage strategy should open after authorization.
 */
export function resolveStoredObjectRef({
  filepath,
  source,
  storageKey,
}: StorageMetadataInput): StoredObjectRef | null {
  const resolvedSource = source || FileSources.local;

  if (resolvedSource === FileSources.s3 || resolvedSource === FileSources.cloudfront) {
    try {
      const key = stripTransportSuffix(
        resolveStoredS3Key({ filepath: filepath || '', storageKey }),
      ).replace(/^\/+/, '');
      if (!key) {
        return null;
      }
      return {
        identity: `${resolvedSource}:${key}`,
        streamPath: key,
      };
    } catch {
      return null;
    }
  }

  const rawStreamPath = storageKey || filepath || '';
  const identityPath = stripTransportSuffix(rawStreamPath);
  if (!identityPath) {
    return null;
  }
  return {
    identity: `${resolvedSource}:${identityPath}`,
    // Local code-output images use query strings only for cache busting.
    // Remote providers may require their signed query parameters to stream.
    streamPath: resolvedSource === FileSources.local ? identityPath : rawStreamPath,
  };
}

export function getStorageMetadata({
  filepath,
  source,
  storageKey,
  storageRegion,
}: StorageMetadataInput): Pick<SaveURLResult, 'storageKey' | 'storageRegion'> {
  if (source !== FileSources.s3 && source !== FileSources.cloudfront) {
    return {};
  }

  let key = storageKey ?? '';
  if (!key && filepath) {
    try {
      key = extractKeyFromS3Url(filepath);
    } catch (error) {
      logger.warn('[getStorageMetadata] Unable to extract storage key from filepath', error);
      return {};
    }
  }
  if (!key) {
    return {};
  }

  const metadata = getStorageMetadataForKey(key);
  if (!metadata.storageKey) {
    return {};
  }

  if (storageRegion && metadata.storageRegion && storageRegion !== metadata.storageRegion) {
    logger.warn(
      `[getStorageMetadata] storageRegion "${storageRegion}" does not match key region "${metadata.storageRegion}".`,
    );
  }

  return {
    ...metadata,
    ...(storageRegion ? { storageRegion } : {}),
  };
}
