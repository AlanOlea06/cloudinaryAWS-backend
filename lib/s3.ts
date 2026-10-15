import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const region = process.env.AWS_REGION || 'us-east-1';
const bucketName = process.env.AWS_S3_BUCKET_NAME || '';

/**
 * Verifica si las credenciales y el bucket de AWS están configurados
 */
export function isAwsConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET_NAME
  );
}

/**
 * Instancia del cliente de S3 configurado con las credenciales de entorno
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
 * Genera una URL pre-firmada real de AWS S3 para subida directa (PUT)
 * 
 * @param key Ruta dentro del bucket (ej: pendientes/{userId}/{fileName})
 * @param contentType Tipo MIME del archivo (ej: image/png)
 * @param expiresInSeconds Tiempo de expiración en segundos (por defecto 900 = 15 min)
 */
export async function generatePresignedUploadUrl(
  key: string,
  contentType: string = 'application/octet-stream',
  expiresInSeconds: number = 900
): Promise<string | null> {
  const client = getS3Client();
  if (!client || !bucketName) {
    return null;
  }

  const command = new PutObjectCommand({
    Bucket: bucketName.trim(),
    Key: key,
    ContentType: contentType,
  });

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Elimina objetos de S3 cuyo prefijo coincida (ej: pendientes/{userId}/)
 * 
 * @param prefix Prefijo a buscar y eliminar
 * @returns Número de objetos eliminados
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
    console.error('Error eliminando objetos en S3 por prefijo:', error);
    throw error;
  }
}
