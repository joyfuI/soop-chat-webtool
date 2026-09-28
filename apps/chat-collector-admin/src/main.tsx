import UIProvider from '@joyfui/ui/theme/UIProvider';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <UIProvider
        themeOptions={{
          palette: { primary: { main: '#315be8' } },
          shape: { borderRadius: 8 },
          typography: {
            h5: { fontWeight: 700 },
            button: { textTransform: 'none', fontWeight: 600 },
          },
          components: {
            MuiButton: { defaultProps: { disableElevation: true } },
            MuiTableCell: {
              styleOverrides: {
                root: { padding: '14px 16px' },
                head: { fontWeight: 600 },
              },
            },
          },
        }}
      >
        <App />
      </UIProvider>
    </StrictMode>,
  );
}
