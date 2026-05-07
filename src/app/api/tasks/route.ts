import { NextRequest, NextResponse } from 'next/server';
import { TASK_MGR } from '@/lib/agent/managers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    try {
        const { subject, description } = await req.json();
        if (!subject || typeof subject !== 'string' || !subject.trim()) {
            return NextResponse.json({ error: 'Subject is required' }, { status: 400 });
        }
        const result = TASK_MGR.create(subject.trim(), description || '', 'user');
        return NextResponse.json({ success: true, task: JSON.parse(result) });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const { id, status } = await req.json();
        if (typeof id !== 'number') {
            return NextResponse.json({ error: 'Task id is required' }, { status: 400 });
        }
        const result = TASK_MGR.update(id, status || null, null, null, 'user');
        return NextResponse.json({ success: true, task: JSON.parse(result) });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const { id } = await req.json();
        if (typeof id !== 'number') {
            return NextResponse.json({ error: 'Task id is required' }, { status: 400 });
        }
        const result = TASK_MGR.update(id, 'deleted', null, null, 'user');
        return NextResponse.json({ success: true, message: result });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
