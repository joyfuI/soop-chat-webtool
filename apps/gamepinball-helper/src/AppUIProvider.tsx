import UIProvider from '@joyfui/ui/theme/UIProvider';
import type { PaletteOptions } from '@mui/material/styles';
import type { PropsWithChildren } from 'react';

import useStore from './hooks/useStore';
import palette from './shared/palette.json';

const AppUIProvider = ({ children }: PropsWithChildren) => {
  const [streamerId] = useStore('setup.streamerId');

  return (
    <UIProvider
      themeOptions={{
        palette: (palette as Record<string, PaletteOptions>)[streamerId],
      }}
    >
      {children}
    </UIProvider>
  );
};

export default AppUIProvider;
