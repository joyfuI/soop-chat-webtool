import type { PaletteOptions } from '@mui/material/styles';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { PropsWithChildren } from 'react';

import useStore from './hooks/useStore';
import palette from './shared/palette.json';

const PaletteProvider = ({ children }: PropsWithChildren) => {
  const [streamerId] = useStore('setup.streamerId');

  const theme = createTheme({
    palette: (palette as Record<string, PaletteOptions>)[streamerId],
  });

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
};

export default PaletteProvider;
