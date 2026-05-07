import { NextResponse } from 'next/server';
import { triggerAbort } from '../route';

export async function POST() {
    triggerAbort();
    return NextResponse.json({ status: 'aborted' });
}
