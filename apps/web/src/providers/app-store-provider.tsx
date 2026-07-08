"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";

import { createAppStore, type AppStore } from "@/stores/app-store";

export type AppStoreApi = ReturnType<typeof createAppStore>;

const AppStoreContext = createContext<AppStoreApi | undefined>(undefined);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createAppStore());

  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  );
}

export function useAppStore<T>(selector: (store: AppStore) => T): T {
  const appStoreContext = useContext(AppStoreContext);

  if (!appStoreContext) {
    throw new Error("useAppStore must be used within AppStoreProvider");
  }

  return useStore(appStoreContext, selector);
}
