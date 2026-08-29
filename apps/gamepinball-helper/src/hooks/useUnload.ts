import { useEffect, useEffectEvent } from 'react';

/**
 * beforeunload 이벤트 훅
 * @param callback 페이지를 벗어날 때 실행할 함수
 */
const useUnload = <T>(callback: (event: BeforeUnloadEvent) => T) => {
  const func = useEffectEvent(callback);

  useEffect(() => {
    window.addEventListener('beforeunload', func);
    return () => {
      window.removeEventListener('beforeunload', func);
    };
  }, []);
};

export default useUnload;
