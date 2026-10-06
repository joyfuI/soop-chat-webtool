import type { PropsWithChildren } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { deserializeChannelResolutionError, SoopChat } from 'soop-chat/browser';

import useComponentWillUnmount from './hooks/useComponentWillUnmount';
import api from './lib/api';

type SoopChatContextValue = {
  chat: SoopChat | null;
  connectChat: (streamerId: string) => Promise<void>;
};

const SoopChatContext = createContext<SoopChatContextValue | null>(null);

export const SoopChatProvider = ({ children }: PropsWithChildren) => {
  const [chat, setChat] = useState<SoopChatContextValue['chat']>(null);
  const chatRef = useRef<SoopChatContextValue['chat']>(null);

  const connectChat = useCallback(async (streamerId: string) => {
    const soopChat = new SoopChat({
      streamerId,
      resolveChannel: async (streamerId, { signal }) => {
        const response = await api.channel.$get(
          { query: { streamerId } },
          { init: { signal } },
        );
        if (!response.ok) {
          const data = await response.json();
          throw deserializeChannelResolutionError(data, { streamerId });
        }
        return response.json();
      },
    });
    // 기존 연결 끊고 연결
    chatRef.current?.disconnect().catch(console.error);
    chatRef.current = soopChat;
    setChat(soopChat);
    await soopChat.connect();
  }, []);

  useComponentWillUnmount(() => {
    chatRef.current?.disconnect().catch(console.error);
  });

  return (
    <SoopChatContext.Provider value={{ chat, connectChat }}>
      {children}
    </SoopChatContext.Provider>
  );
};

export const useSoopChat = () => {
  const context = useContext(SoopChatContext);
  if (!context) {
    throw new Error('useSoopChat은 SoopChatProvider 내에서 사용해야 합니다.');
  }

  return context;
};
