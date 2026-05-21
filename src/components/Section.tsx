"use client";

import React from 'react';
import { ChevronRight } from 'lucide-react';

interface Props {
    title: string;
    titleClass: string;
    icon?: React.ReactNode;
    count?: React.ReactNode;
    defaultOpen?: boolean;
    children: React.ReactNode;
}

export function Section({ title, titleClass, icon, count, defaultOpen = true, children }: Props) {
    return (
        <details open={defaultOpen} className="group/section">
            <summary className="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none hover:bg-[var(--bg-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/30 transition-colors list-none [&::-webkit-details-marker]:hidden">
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] transition-transform group-open/section:rotate-90 shrink-0" />
                {icon}
                <span className={titleClass}>{title}</span>
                {count && <span className="ml-auto">{count}</span>}
            </summary>
            <div className="px-4 pb-3">
                {children}
            </div>
        </details>
    );
}
