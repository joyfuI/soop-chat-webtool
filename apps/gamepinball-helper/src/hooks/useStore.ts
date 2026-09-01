import { useCallback } from 'react';

import type { StoreKey, StoreType } from '../types';
import { storeSchema } from '../types';
import { useLocalStorage } from './useStorage';

const useStore = <K extends StoreKey>(key: K) => {
  const schema = storeSchema[key];
  const defaultValue = schema.parse(undefined) as StoreType[K];

  const [item, setItem, delValue] = useLocalStorage(key, defaultValue);

  const parseValue = useCallback(
    (value: unknown): StoreType[K] => {
      const result = schema.safeParse(value);
      return result.success ? (result.data as StoreType[K]) : defaultValue;
    },
    [schema, defaultValue],
  );

  const storedValue = parseValue(item);

  const setValue = useCallback(
    (newValue: StoreType[K] | ((oldValue: StoreType[K]) => StoreType[K])) => {
      setItem((originOldValue) => {
        const oldValue = parseValue(originOldValue);
        const value =
          typeof newValue === 'function' ? newValue(oldValue) : newValue;
        return schema.parse(value) as StoreType[K];
      });
    },
    [schema, parseValue, setItem],
  );

  return [storedValue, setValue, delValue] as const;
};

export default useStore;
