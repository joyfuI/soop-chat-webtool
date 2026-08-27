import type { PaletteOptions } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';
import { useMemo } from 'react';

import palette from '../shared/palette.json';
import type { StoreType } from '../types';
import { useLocalStorage } from './useStorage';

const usePalette = () => {
  const [id] = useLocalStorage<StoreType['setup.id']>('setup.id', '');

  return useMemo(
    () =>
      createTheme({ palette: (palette as Record<string, PaletteOptions>)[id] }),
    [id],
  );
};

export default usePalette;
