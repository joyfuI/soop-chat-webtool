import { useCallback, useSyncExternalStore } from 'react';

import { useSoopChat } from '../SoopChatContext';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

const useChatState = (): ConnectionStatus => {
  const { chat } = useSoopChat();

  const subscribe = useCallback(
    (callback: () => void) =>
      chat?.on('stateChange', (event) => {
        console.log('stateChange', new Date().toLocaleString(), event);
        callback();
      }) ?? (() => {}),
    [chat],
  );

  const getSnapshot = useCallback(() => {
    switch (chat?.state) {
      case undefined:
      case 'idle':
      case 'closed':
        return 'disconnected';

      case 'resolving':
      case 'connecting':
      case 'reconnecting':
        return 'connecting';

      case 'connected':
        return 'connected';
    }
  }, [chat]);

  return useSyncExternalStore(subscribe, getSnapshot);
};

export default useChatState;
