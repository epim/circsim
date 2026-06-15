/**
 * renderer/store/storeContext.tsx — Task 21
 *
 * React context that provides the single app-wide `AppStore` to panels, plus a
 * convenience selector hook. The store itself is created in the renderer
 * entrypoint with the real port-backed simClient; tests create their own and
 * pass it directly (no provider needed) so this file stays UI-only.
 */

import React, { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { AppState, AppStore } from './appStore'

const AppStoreContext = createContext<AppStore | null>(null)

export function AppStoreProvider({
  store,
  children,
}: {
  store: AppStore
  children: React.ReactNode
}): React.ReactElement {
  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>
}

/** Get the raw store (for imperative actions). Throws if no provider is mounted. */
export function useAppStoreApi(): AppStore {
  const store = useContext(AppStoreContext)
  if (!store) throw new Error('useAppStoreApi must be used within <AppStoreProvider>')
  return store
}

/** Selector hook bound to the context store. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useAppStoreApi(), selector)
}
