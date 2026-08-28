import UIProvider from '@joyfui/ui/theme/UIProvider';
import { SnackbarProvider } from 'notistack';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import PaletteProvider from './PaletteProvider';
import RerollTimerApp from './RerollTimerApp';
import { SoopChatProvider } from './SoopChatContext';

const rootElement = document.getElementById('root');
const windowType = new URLSearchParams(window.location.search).get('window');
if (rootElement && !rootElement.innerHTML) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <UIProvider>
        <PaletteProvider>
          <SnackbarProvider>
            {windowType === 'reroll-timer' ? (
              <SoopChatProvider>
                <RerollTimerApp />
              </SoopChatProvider>
            ) : (
              <SoopChatProvider>
                <App />
              </SoopChatProvider>
            )}
          </SnackbarProvider>
        </PaletteProvider>
      </UIProvider>
    </StrictMode>,
  );
}
