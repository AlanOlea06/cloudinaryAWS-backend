import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const region = process.env.AWS_REGION || 'us-east-1';
const bucketName = process.env.AWS_S3_BUCKET_NAME || '';

export const PRIVATE_NO_STORE_CACHE_CONTROL =
  'private, no-store, no-cache, max-age=0, must-revalidate';

// Short TTL (5 minutes = 300s) for public files because IAM lacks cloudfront:CreateInvalidation
export const PUBLIC_SHORT_TTL_CACHE_CONTROL =
  'public, max-age=300, must-revalidate';

/**
 * Returns the appropriate Cache-Control directive based on file visibility and landing stage.
 * - Pending uploads and private files NEVER cache ('private, no-store, no-cache, max-age=0, must-revalidate').
 * - Public files use a short 5-minute Edge TTL ('public, max-age=300, must-revalidate').
 */
export function getCacheControlForVisibility(
  visibility: string = 'private',
  isPending: boolean = false
): string {
  if (isPending || visibility.toLowerCase() === 'private') {
    return PRIVATE_NO_STORE_CACHE_CONTROL;
  }
  return PUBLIC_SHORT_TTL_CACHE_CONTROL;
}

/**
 * Task A.1: Generates an unpredictable 128-bit (16-byte / 32 hex chars) opaque S3 key.
 * - Distinct from the database file ID and ticket ID.
 * - Never includes organization slug, visibility ('private'/'public'), or original filename.
 * - Always resides under 'static/' so CloudFront (/static/*) can reach public files when needed.
 */
export function generateOpaqueS3Key(
  prefix: 'static/pending' | 'static/files' = 'static/pending',
  extension: string = ''
): string {
  const random128Hex = crypto.randomBytes(16).toString('hex');
  let cleanExt = (extension || '').trim().toLowerCase();
  if (cleanExt && !cleanExt.startsWith('.')) {
    cleanExt = `.${cleanExt}`;
  }
  // Keep only safe alphanumeric extension characters
  cleanExt = cleanExt.replace(/[^a-z0-9.]/g, '');
  return `${prefix}/${random128Hex}${cleanExt}`;
}

/**
 * Checks if AWS S3 credentials and bucket name are configured in environment variables
 */
export function isAwsConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET_NAME
  );
}

/**
 * Returns an S3Client instance configured with environment credentials
 */
export function getS3Client(): S3Client | null {
  if (!isAwsConfigured()) {
    return null;
  }

  return new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!.trim(),
    },
  });
}

/**
 * Task A.3: Generates an AWS S3 Presigned URL for direct client upload (PUT)
 * with Cache-Control cryptographically signed in X-Amz-SignedHeaders.
 *
 * @param key Destination path within the bucket (e.g. static/pending/<rand128>.<ext>)
 * @param contentType MIME type of the file (e.g. image/png)
 * @param expiresInSeconds Lifetime in seconds (default 300 = 5 minutes)
 * @param cacheControl Cache-Control header to sign (defaults to no-store for pending/private)
 */
export async function generatePresignedUploadUrl(
  key: string,
  contentType: string = 'application/octet-stream',
  expiresInSeconds: number = 300,
  cacheControl: string = PRIVATE_NO_STORE_CACHE_CONTROL
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName) {
    return null;
  }

  const command = new PutObjectCommand({
    Bucket: bucketName.trim(),
    Key: key,
    ContentType: contentType,
    CacheControl: cacheControl,
  });

  return await getSignedUrl(client, command, {
    expiresIn: expiresInSeconds,
    signableHeaders: new Set(['host', 'content-type', 'cache-control']),
  });
}

/**
 * Task A.2: Generates a short-lived (5-minute) S3 Presigned GET URL for private files.
 * Private files are NEVER served or cached through CloudFront.
 */
export async function generatePresignedReadUrl(
  key: string,
  expiresInSeconds: number = 300
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName || !key) {
    return null;
  }

  const command = new GetObjectCommand({
    Bucket: bucketName.trim(),
    Key: key.replace(/^\/+/, ''),
    ResponseCacheControl: PRIVATE_NO_STORE_CACHE_CONTROL,
  });

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Updates the S3 object's Cache-Control metadata in-place after upload confirmation.
 * - For 'private' files: sets 'private, no-store, no-cache, max-age=0, must-revalidate'
 * - For 'public' files: sets 'public, max-age=300, must-revalidate' (short TTL since CloudFront invalidation is unavailable)
 */
export async function applyS3CacheControlMetadata(
  key: string,
  contentType: string = 'application/octet-stream',
  visibility: string = 'private'
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName || !key) {
    return null;
  }

  const cacheControl = getCacheControlForVisibility(visibility, false);

  const trimmedBucket = bucketName.trim();
  const cleanKey = key.replace(/^\/+/, '');
  const encodedCopySource = `${trimmedBucket}/${cleanKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;

  const copyCommand = new CopyObjectCommand({
    Bucket: trimmedBucket,
    CopySource: encodedCopySource,
    Key: cleanKey,
    ContentType: contentType,
    CacheControl: cacheControl,
    MetadataDirective: 'REPLACE',
  });

  await client.send(copyCommand);
  return cacheControl;
}

/**
 * Deletes S3 objects matching a given prefix (e.g. pending/{userId}/)
 * 
 * @param prefix S3 Key prefix to search and delete
 * @returns Object with count and deleted keys
 */
export async function deleteS3ObjectsByPrefix(prefix: string): Promise<{ count: number; keys: string[] }> {
  const client = getS3Client();
  if (!client || !bucketName) {
    return { count: 0, keys: [] };
  }

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName.trim(),
      Prefix: prefix,
    });

    const listRes = await client.send(listCommand);
    if (!listRes.Contents || listRes.Contents.length === 0) {
      return { count: 0, keys: [] };
    }

    const objectsToDelete = listRes.Contents
      .map((item) => ({ Key: item.Key }))
      .filter((item): item is { Key: string } => Boolean(item.Key));

    if (objectsToDelete.length === 0) {
      return { count: 0, keys: [] };
    }

    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName.trim(),
      Delete: {
        Objects: objectsToDelete,
        Quiet: false,
      },
    });

    const deleteRes = await client.send(deleteCommand);
    const deletedKeys = (deleteRes.Deleted || []).map((d) => d.Key || '').filter(Boolean);

    return {
      count: deletedKeys.length,
      keys: deletedKeys,
    };
  } catch (error) {
    console.error('Error deleting S3 objects by prefix:', error);
    throw error;
  }
}

/**
 * Deletes specific S3 objects by their exact keys
 * 
 * @param keys Array of S3 keys to delete
 * @returns Object with count and deleted keys
 */
export async function deleteS3ObjectsByKeys(keys: string[]): Promise<{ count: number; keys: string[] }> {
  const client = getS3Client();
  if (!client || !bucketName || keys.length === 0) {
    return { count: 0, keys: [] };
  }

  try {
    const validObjects = keys
      .filter((k) => typeof k === 'string' && k.trim().length > 0)
      .map((k) => ({ Key: k.trim() }));

    if (validObjects.length === 0) {
      return { count: 0, keys: [] };
    }

    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName.trim(),
      Delete: {
        Objects: validObjects,
        Quiet: false,
      },
    });

    const deleteRes = await client.send(deleteCommand);
    const deletedKeys = (deleteRes.Deleted || []).map((d) => d.Key || '').filter(Boolean);

    return {
      count: deletedKeys.length,
      keys: deletedKeys,
    };
  } catch (error) {
    console.error('Error deleting S3 objects by keys:', error);
    throw error;
  }
}

