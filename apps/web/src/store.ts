import type { CableType } from '@netlab/engine';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Me } from './api';

export type Tool = { kind: 'select' } | { kind: 'cable'; cable: CableType | 'auto' } | { kind: 'note' } | { kind: 'zone' } | { kind: 'pdu' };
export type Mode = 'realtime' | 'simulation';
export type Page = 'home' | 'teacher' | 'student' | 'courses' | 'exercises' | 'profile';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

interface UiState {
  locale: 'fr' | 'en';
  theme: 'dark' | 'light';
  showPorts: boolean;
  showIps: boolean;
  snap: boolean;
  minimap: boolean;
  bottomHeight: number;
  /** Open project tabs (local ids) and the active one. */
  tabs: string[];
  active: string | null;
  me: Me | null;
  tool: Tool;
  mode: Mode;
  page: Page;
  selection: string[];
  cliDevice: string | null;
  windowDevice: string | null;
  toasts: Toast[];
  set(p: Partial<UiState>): void;
  toast(text: string, tone?: Toast['tone']): void;
}

let toastId = 0;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      locale: navigator.language.startsWith('fr') ? 'fr' : 'en',
      theme: 'dark',
      showPorts: false,
      showIps: false,
      snap: true,
      minimap: true,
      bottomHeight: 220,
      tabs: [],
      active: null,
      me: null,
      tool: { kind: 'select' },
      mode: 'realtime',
      page: 'home',
      selection: [],
      cliDevice: null,
      windowDevice: null,
      toasts: [],
      set: (p) => set(p),
      toast: (text, tone = 'info') => {
        const id = ++toastId;
        set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
      },
    }),
    {
      name: 'netlab-ui',
      partialize: (s) => ({ locale: s.locale, theme: s.theme, showPorts: s.showPorts, showIps: s.showIps, snap: s.snap, minimap: s.minimap, bottomHeight: s.bottomHeight, tabs: s.tabs, active: s.active }),
    },
  ),
);
