import { useEffect, useEffectEvent } from 'react';

/**
 * componentWillUnmount 훅
 * @param callback 컴포넌트가 언마운트 되기 직전에 실행할 함수
 */
const useComponentWillUnmount = (callback: () => void) => {
  const func = useEffectEvent(callback);

  useEffect(
    () => () => {
      func();
    },
    [],
  );
};

export default useComponentWillUnmount;
