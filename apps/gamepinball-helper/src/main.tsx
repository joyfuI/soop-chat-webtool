import { SnackbarProvider } from 'notistack';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import AppUIProvider from './AppUIProvider';
import RerollTimerApp from './RerollTimerApp';
import { SoopChatProvider } from './SoopChatContext';

const rootElement = document.getElementById('root');
const windowType = new URLSearchParams(window.location.search).get('window');
if (rootElement && !rootElement.innerHTML) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <AppUIProvider>
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
      </AppUIProvider>
    </StrictMode>,
  );
}
