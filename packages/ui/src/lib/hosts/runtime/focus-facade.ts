import React from 'react';
import { useStore } from 'zustand/react';
import type { StoreApi } from 'zustand/vanilla';

import { HostScopeContext } from './HostScope';
import { getAmbientHost } from './ambient-host';
import type { EveryHostListener, HostBoundStore, HostId, HostRegistry, HostRuntime, HostStoreKey, HostStoreScope } from './types';

const isMemberOf = <T extends object>(target: T, property: PropertyKey): property is keyof T => property in target;

const readMember = <T extends object>(target: T, property: string | symbol) => {
  if (!isMemberOf(target, property)) return undefined;
  const value = target[property];
  return value instanceof Function ? value.bind(target) : value;
};

const callMember = <T extends object>(target: T, property: string | symbol, args: unknown[]) => {
  const method = isMemberOf(target, property) ? target[property] : undefined;
  if (!(method instanceof Function)) throw new TypeError(`${String(property)} is not a method of the resolved object`);
  return method.apply(target, args);
};

const blueprintMembers = <T extends object>(blueprint: T): Map<string | symbol, PropertyDescriptor> => {
  const members = new Map<string | symbol, PropertyDescriptor>();
  for (let layer: object | null = blueprint; layer !== null && layer !== Object.prototype; layer = Object.getPrototypeOf(layer)) {
    for (const property of Reflect.ownKeys(layer)) {
      const descriptor = Object.getOwnPropertyDescriptor(layer, property);
      if (property === 'constructor' || members.has(property) || !descriptor) continue;
      members.set(property, descriptor);
    }
  }
  return members;
};

export const createFocusFacade = <T extends object>(blueprint: T, resolve: () => T): T => {
  const facade: T = Object.create(blueprint);
  for (const [property, descriptor] of blueprintMembers(blueprint)) {
    Object.defineProperty(facade, property, descriptor.value instanceof Function
      ? { configurable: true, writable: true, value: (...args: unknown[]) => callMember(resolve(), property, args) }
      : { configurable: true, get: () => readMember(resolve(), property), set: (value) => { Reflect.set(resolve(), property, value); } });
  }
  return facade;
};

export const bindHostActions = <S extends object>(host: HostRuntime, state: S): S => {
  const bound: S = { ...state };
  for (const property of Reflect.ownKeys(bound)) {
    const action = isMemberOf(bound, property) ? bound[property] : undefined;
    if (!(action instanceof Function)) continue;
    Object.defineProperty(bound, property, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (...args: unknown[]) => host.run(() => action.apply(bound, args)),
    });
  }
  return bound;
};

const selectWhole = <S,>(state: S): S => state;

export const createHostBindings = (registry: HostRegistry) => {
  const resolveHost = (): HostRuntime => getAmbientHost() ?? registry.focused();

  const requireHost = (id: HostId): HostRuntime => {
    const host = registry.get(id);
    if (!host) throw new Error(`Unknown host: ${id}`);
    return host;
  };

  const defineHostStore = <S, A extends StoreApi<S> = StoreApi<S>>(name: string, factory: (host: HostRuntime) => A): HostBoundStore<S, A> => {
    const stores = new WeakMap<HostStoreScope, A>();
    const everyHostListeners = new Set<EveryHostListener<S>>();
    const storeOf = (host: HostRuntime): A => {
      const existing = stores.get(host.storeScope);
      if (existing) return existing;
      const created = host.run(() => factory(host));
      created.subscribe((state, previous) => {
        for (const listener of everyHostListeners) host.run(() => listener(state, previous, host));
      });
      stores.set(host.storeScope, created);
      return created;
    };
    const key: HostStoreKey<S> = { name, resolve: storeOf };
    const resolveStore = (): StoreApi<S> => resolveHost().instance(key);

    const setState = (
      ...args: [S | Partial<S> | ((state: S) => S | Partial<S>), false?] | [S | ((state: S) => S), true]
    ): void => {
      const store = resolveStore();
      if (args[1] === true) store.setState(args[0], true);
      else store.setState(args[0], args[1]);
    };

    const subscribe = (listener: (state: S, previousState: S) => void): (() => void) => {
      const ambient = getAmbientHost();
      if (ambient) return ambient.instance(key).subscribe(listener);
      let store = registry.focused().instance(key);
      let unsubscribeStore = store.subscribe(listener);
      const unsubscribeFocus = registry.subscribe(() => {
        if (registry.list().length === 0) return;
        const next = registry.focused().instance(key);
        if (next === store) return;
        const previous = store;
        unsubscribeStore();
        store = next;
        unsubscribeStore = next.subscribe(listener);
        listener(next.getState(), previous.getState());
      });
      return () => {
        unsubscribeFocus();
        unsubscribeStore();
      };
    };

    function useHostStore(): S;
    function useHostStore<U>(selector: (state: S) => U): U;
    function useHostStore<U>(selector?: (state: S) => U): S | U {
      const scopedId = React.useContext(HostScopeContext);
      const readHost = (): HostRuntime => (scopedId === null ? registry.focused() : requireHost(scopedId));
      const host = React.useSyncExternalStore(registry.subscribe, readHost, readHost);
      const select: (state: S) => S | U = selector ?? selectWhole;
      return useStore(host.instance(key), select);
    }

    return Object.assign(useHostStore, {
      getState: () => resolveStore().getState(),
      getInitialState: () => resolveStore().getInitialState(),
      setState,
      subscribe,
      subscribeEveryHost: (listener: EveryHostListener<S>) => {
        everyHostListeners.add(listener);
        return () => {
          everyHostListeners.delete(listener);
        };
      },
      forHost: (id: HostId) => storeOf(requireHost(id)),
    });
  };

  const defineHostValue = <T,>(factory: (host: HostRuntime) => T): (() => T) => {
    const values = new WeakMap<HostStoreScope, { value: T }>();
    return () => {
      const host = resolveHost();
      const existing = values.get(host.storeScope);
      if (existing) return existing.value;
      const created = { value: host.run(() => factory(host)) };
      values.set(host.storeScope, created);
      return created.value;
    };
  };

  return { resolveHost, defineHostStore, defineHostValue };
};
