import type { PropsWithChildren } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';
import { SoopChat } from 'soop-chat/browser';

import api from './lib/api';

type SoopChatContextValue = {
  chat: SoopChat | null;
  connectChat: (streamerId: string) => Promise<void>;
};

const SoopChatContext = createContext<SoopChatContextValue | null>(null);

export const SoopChatProvider = ({ children }: PropsWithChildren) => {
  const [chat, setChat] = useState<SoopChatContextValue['chat']>(null);

  const connectChat = useCallback(async (streamerId: string) => {
    const chat = new SoopChat({
      streamerId,
      resolveChannel: async (streamerId, { signal }) => {
        const response = await api.channel.$get(
          { query: { streamerId } },
          { init: { signal } },
        );
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.message);
        }
        return response.json();
      },
    });
    setChat(chat);
    await chat.connect();
  }, []);

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
