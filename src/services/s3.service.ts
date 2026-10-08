import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/s3.js';
import { env } from '../config/env.js';

interface GeneratePresignedUrlParams {
  key: string;
  contentType: string;
  contentLength: number;
}

export class S3Service {
  /**
   * Genera una URL prefirmada (Pre-signed URL) de AWS S3 para PUT directo desde el navegador.
   */
  static async generateUploadPresignedUrl({
    key,
    contentType,
    contentLength,
  }: GeneratePresignedUrlParams): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });

    return await getSignedUrl(s3Client, command, {
      expiresIn: env.UPLOAD_URL_EXPIRATION_SECONDS,
    });
  }
}
