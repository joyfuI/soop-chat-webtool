import type { StoreKey, StoreType } from '../types';
import { storeSchema } from '../types';
import { useLocalStorage } from './useStorage';

const useStore = <K extends StoreKey>(key: K) => {
  return useLocalStorage<StoreType[K]>(
    key,
    storeSchema[key].parse(undefined) as StoreType[K],
  );
};

export default useStore;
