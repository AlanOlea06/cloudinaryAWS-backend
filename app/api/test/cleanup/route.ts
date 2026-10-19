import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { isAwsConfigured, deleteS3ObjectsByPrefix, deleteS3ObjectsByKeys } from '@/lib/s3';
import { addServiceLog } from '@/lib/service-logs';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Common cleanup handler for DELETE and POST
 */
async function handleCleanup(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let userId = searchParams.get('userId') || 'a1111111-0000-0000-0000-000000000001';
    let cleanAll = searchParams.get('all') === 'true';

    // Parse body payload if provided
    try {
      const body = await req.json().catch(() => ({}));
      if (body.userId) userId = body.userId;
      if (body.all !== undefined) cleanAll = Boolean(body.all);
    } catch {
      // Ignore if body is empty
    }

    const s3PrefixPending = cleanAll ? 'pending/' : `pending/${userId}/`;
    let s3DeletedCount = 0;
    let s3DeletedKeys: string[] = [];
    let s3Status = 'aws_not_configured';

    // 1. Purge S3 Objects under 'pending/'
    if (isAwsConfigured()) {
      try {
        if (cleanAll) {
          const resPending = await deleteS3ObjectsByPrefix('pending/');
          s3DeletedCount = resPending.count;
          s3DeletedKeys = resPending.keys;
        } else {
          // Look up user's pending keys from Supabase files table before deleting database records
          const { data: userFiles } = await supabase
            .from('files')
            .select('s3_pending_key')
            .eq('user_id', userId);

          const keysToDelete: string[] = [];
          (userFiles || []).forEach((f: any) => {
            if (f.s3_pending_key) keysToDelete.push(f.s3_pending_key);
          });

          // Delete specific keys (e.g. pending/{fileId}{ext})
          const resKeys = await deleteS3ObjectsByKeys(keysToDelete);
          // Also clean legacy user prefix (pending/{userId}/...) if present
          const resLegacyPending = await deleteS3ObjectsByPrefix(`pending/${userId}/`);

          s3DeletedCount = resKeys.count + resLegacyPending.count;
          s3DeletedKeys = [...resKeys.keys, ...resLegacyPending.keys];
        }
        s3Status = 'success';
      } catch (s3Err: any) {
        console.error('Error cleaning up S3 objects:', s3Err.message);
        s3Status = `error: ${s3Err.message}`;
      }
    }

    // 2. Clean File Records in Supabase (files table)
    try {
      if (cleanAll) {
        await supabase.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      } else {
        await supabase.from('files').delete().eq('user_id', userId);
      }
    } catch (e: any) {
      console.warn('Warning cleaning up files table:', e.message);
    }

    // 3. Clean Audit Logs in Supabase (service_logs table)
    try {
      if (cleanAll) {
        await supabase.from('service_logs').delete().not('created_at', 'is', null);
      } else {
        await supabase.from('service_logs').delete().eq('user_id', userId);
      }
    } catch (e: any) {
      console.warn('Warning cleaning up service_logs table:', e.message);
    }

    // Record cleanup audit log
    await addServiceLog({
      action: 'TEST_ENVIRONMENT_CLEANUP',
      status: 'ALLOWED',
      userId: cleanAll ? 'admin-system' : userId,
      userName: cleanAll ? 'System (Global)' : 'Test User',
      details: {
        s3Prefix: s3PrefixPending,
        s3DeletedCount,
        s3Status,
        cleanAll,
        cleanedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(
      {
        status: 'success',
        message: 'Test environment cleanup completed successfully.',
        cleanupScope: {
          cleanAll,
          targetUserId: cleanAll ? 'ALL' : userId,
          s3PrefixCleaned: s3PrefixPending,
        },
        results: {
          s3: {
            configured: isAwsConfigured(),
            status: s3Status,
            deletedCount: s3DeletedCount,
            deletedKeys: s3DeletedKeys,
          },
          supabase: {
            filesTable: 'Cleaned successfully',
            serviceLogsTable: 'Cleaned successfully',
          },
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        status: 'error',
        message: 'Error executing test cleanup',
        error: error.message,
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(req: NextRequest) {
  return handleCleanup(req);
}

export async function POST(req: NextRequest) {
  return handleCleanup(req);
}

export async function GET(req: NextRequest) {
  return NextResponse.json(
    {
      message: 'Test cleanup endpoint (5GB Free Tier Protection)',
      usage: {
        method: 'DELETE (or POST)',
        url: '/api/test/cleanup',
        queryParams: {
          userId: 'Test User ID to clean up (optional, defaults to Carlos Mendoza)',
          all: 'true to purge all test files under pending/ (optional)',
        },
        examples: [
          'DELETE /api/test/cleanup',
          'DELETE /api/test/cleanup?userId=a1111111-0000-0000-0000-000000000001',
          'DELETE /api/test/cleanup?all=true',
        ],
      },
      awsConfigured: isAwsConfigured(),
    },
    { status: 200, headers: corsHeaders }
  );
}
