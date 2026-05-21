'use client';
import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';

export function useTheme() {
    const [theme, setThemeState] = useState<Theme>('dark');

    useEffect(() => {
        const stored = localStorage.getItem('theme') as Theme | null;
        const preferred = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        const initial = stored || preferred;
        setThemeState(initial);
        document.documentElement.setAttribute('data-theme', initial);
    }, []);

    const setTheme = useCallback((t: Theme) => {
        setThemeState(t);
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('theme', t);
    }, []);

    const toggle = useCallback(() => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
    }, [theme, setTheme]);

    return { theme, setTheme, toggle };
}
