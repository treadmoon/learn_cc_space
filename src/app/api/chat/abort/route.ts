import { NextResponse } from 'next/server';
import { triggerAbort } from '@/lib/agent/abort';

export async function POST() {
    triggerAbort();
    return NextResponse.json({ status: 'aborted' });
}
