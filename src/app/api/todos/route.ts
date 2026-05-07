import { NextResponse } from 'next/server';
import { TODO } from '@/lib/agent/managers';

export const runtime = 'nodejs';

export async function POST(req: Request) {
    try {
        const { index, status } = await req.json();
        
        if (typeof index !== 'number' || !status) {
            return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
        }
        
        // Ensure index is within boundaries
        if (index >= 0 && index < TODO.items.length) {
            // Because TodoManager update validation logic requires passing the full array,
            // we will mutate the array and pass it back to `TODO.update`
            const newItems = [...TODO.items];
            newItems[index].status = status;
            
            TODO.update(newItems);
            return NextResponse.json({ success: true, todos: TODO.items });
        }
        
        return NextResponse.json({ error: 'Todo out of bounds' }, { status: 400 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
