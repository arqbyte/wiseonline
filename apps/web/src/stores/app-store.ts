import { createStore } from "zustand/vanilla";

export type AppState = {
  sidebarCollapsed: boolean;
};

export type AppActions = {
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
};

export type AppStore = AppState & AppActions;

export const defaultInitState: AppState = {
  sidebarCollapsed: false,
};

export const createAppStore = (initState: AppState = defaultInitState) => {
  return createStore<AppStore>()((set) => ({
    ...initState,
    toggleSidebar: () =>
      set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  }));
};
