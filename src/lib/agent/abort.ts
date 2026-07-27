const globalForAbort = global as unknown as { agentAbortMap: Map<string, AbortController> };
if (!globalForAbort.agentAbortMap) globalForAbort.agentAbortMap = new Map();

export function createAbort(reqId: string): AbortController {
    const ctrl = new AbortController();
    globalForAbort.agentAbortMap.set(reqId, ctrl);
    return ctrl;
}

export function cleanupAbort(reqId: string): void {
    globalForAbort.agentAbortMap.delete(reqId);
}

export function triggerAbort(reqId?: string): void {
    if (reqId) {
        globalForAbort.agentAbortMap.get(reqId)?.abort();
    } else {
        for (const ctrl of globalForAbort.agentAbortMap.values()) ctrl.abort();
    }
}
