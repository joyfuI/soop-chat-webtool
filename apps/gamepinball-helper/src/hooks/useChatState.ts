import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionState } from 'soop-chat';

import { useSoopChat } from '../SoopChatContext';

const useChatState = (): ConnectionState | undefined => {
  const { chat } = useSoopChat();

  const subscribe = useCallback(
    (callback: () => void) =>
      chat?.on('stateChange', (event) => {
        console.log('stateChange', new Date().toLocaleString(), event);
        callback();
      }) ?? (() => {}),
    [chat],
  );

  const getSnapshot = useCallback(() => chat?.state, [chat]);

  return useSyncExternalStore(subscribe, getSnapshot);
};

export default useChatState;
