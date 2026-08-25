import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import { getStorageMetadata, resolveStoredObjectRef } from '../metadata';

// getStorageMetadata uses real S3 key extraction/parsing from crud.ts; no S3 calls are made here.
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('getStorageMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty metadata for non-cloud storage sources', () => {
    expect(
      getStorageMetadata({
        source: FileSources.local,
        filepath: '/images/user123/file.png',
      }),
    ).toEqual({});
  });

  it('returns empty metadata when cloud files have no filepath or storageKey', () => {
    expect(getStorageMetadata({ source: FileSources.s3 })).toEqual({});
    expect(getStorageMetadata({ source: FileSources.cloudfront, filepath: '' })).toEqual({});
  });

  it('uses an explicit storageKey and parses its embedded region', () => {
    expect(
      getStorageMetadata({
        source: FileSources.s3,
        storageKey: 'i/r/us-east-2/t/tenantA/images/user123/photo.png',
      }),
    ).toEqual({
      storageKey: 'i/r/us-east-2/t/tenantA/images/user123/photo.png',
      storageRegion: 'us-east-2',
    });
  });

  it('extracts storage metadata from CloudFront filepaths', () => {
    expect(
      getStorageMetadata({
        source: FileSources.cloudfront,
        filepath:
          'https://cdn.example.com/a/r/eu-central-1/t/tenantA/avatars/user123/avatar.png?Policy=abc',
      }),
    ).toEqual({
      storageKey: 'a/r/eu-central-1/t/tenantA/avatars/user123/avatar.png',
      storageRegion: 'eu-central-1',
    });
  });

  it('returns empty metadata for malformed cloud filepaths', () => {
    expect(
      getStorageMetadata({
        source: FileSources.s3,
        filepath: 'https://cdn.example.com/not-enough',
      }),
    ).toEqual({});
  });

  it('keeps explicit storageRegion on mismatch and logs the mismatch', () => {
    expect(
      getStorageMetadata({
        source: FileSources.s3,
        storageKey: 'r/us-east-2/uploads/user123/report.pdf',
        storageRegion: 'eu-central-1',
      }),
    ).toEqual({
      storageKey: 'r/us-east-2/uploads/user123/report.pdf',
      storageRegion: 'eu-central-1',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[getStorageMetadata] storageRegion "eu-central-1" does not match key region "us-east-2".',
    );
  });
});

describe('resolveStoredObjectRef', () => {
  it('uses one identity for an S3 storage key and its signed URL', () => {
    const storageKey = 'r/us-east-2/uploads/user123/report.pdf';

    const fromKey = resolveStoredObjectRef({
      source: FileSources.s3,
      storageKey,
      filepath: 'https://bucket.s3.amazonaws.com/old-url?X-Amz-Signature=old',
    });
    const fromUrl = resolveStoredObjectRef({
      source: FileSources.s3,
      filepath: `https://bucket.s3.amazonaws.com/${storageKey}?X-Amz-Signature=new`,
    });

    expect(fromKey).toEqual(fromUrl);
    expect(fromKey).toEqual({
      identity: `s3:${storageKey}`,
      streamPath: storageKey,
    });
  });

  it('removes transport-only query and hash suffixes from local paths', () => {
    expect(
      resolveStoredObjectRef({
        source: FileSources.local,
        filepath: '/images/user123/chart.png?v=2#preview',
      }),
    ).toEqual({
      identity: 'local:/images/user123/chart.png',
      streamPath: '/images/user123/chart.png',
    });
  });

  it('preserves a remote signed URL for streaming while excluding its query from identity', () => {
    expect(
      resolveStoredObjectRef({
        source: FileSources.firebase,
        filepath:
          'https://firebasestorage.googleapis.com/v0/b/app/o/uploads%2Freport.pdf?alt=media&token=secret',
      }),
    ).toEqual({
      identity: 'firebase:https://firebasestorage.googleapis.com/v0/b/app/o/uploads%2Freport.pdf',
      streamPath:
        'https://firebasestorage.googleapis.com/v0/b/app/o/uploads%2Freport.pdf?alt=media&token=secret',
    });
  });

  it('returns null when a record has no stored-object locator', () => {
    expect(resolveStoredObjectRef({ source: FileSources.local })).toBeNull();
  });
});
