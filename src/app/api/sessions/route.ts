import { NextRequest, NextResponse } from 'next/server';
import { SESSION_MGR } from '@/lib/agent/managers';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
    const id = req.nextUrl.searchParams.get('id');
    if (id) {
        const session = SESSION_MGR.get(id);
        if (!session) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
        return NextResponse.json({ success: true, data: session });
    }
    return NextResponse.json({ success: true, data: SESSION_MGR.list() });
}

export async function POST() {
    const session = SESSION_MGR.create();
    return NextResponse.json({ success: true, data: session });
}

export async function PATCH(req: NextRequest) {
    const { id, messages, title } = await req.json();
    if (!id || !messages) return NextResponse.json({ success: false, error: 'id and messages required' }, { status: 400 });
    SESSION_MGR.update(id, messages, title);
    return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const ok = SESSION_MGR.delete(id);
    return NextResponse.json({ success: ok });
}
