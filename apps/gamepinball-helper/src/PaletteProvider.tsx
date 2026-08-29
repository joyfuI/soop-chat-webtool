import type { PaletteOptions } from '@mui/material/styles';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { PropsWithChildren } from 'react';

import { useLocalStorage } from './hooks/useStorage';
import palette from './shared/palette.json';
import type { StoreType } from './types';

const PaletteProvider = ({ children }: PropsWithChildren) => {
  const [streamerId] = useLocalStorage<StoreType['setup.streamerId']>(
    'setup.streamerId',
    '',
  );

  const theme = createTheme({
    palette: (palette as Record<string, PaletteOptions>)[streamerId],
  });

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
};

export default PaletteProvider;
