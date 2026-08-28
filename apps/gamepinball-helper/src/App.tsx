import Container from '@mui/material/Container';
import { ThemeProvider } from '@mui/material/styles';
import { useSnackbar } from 'notistack';
import type { SyntheticEvent } from 'react';
import { useEffect, useRef } from 'react';
import type { SoopChatEventMap } from 'soop-chat';

import LinkDial from './components/LinkDial';
import Navigation from './components/Navigation';
import donationCalc from './helper/donationCalc';
import sanitizeText from './helper/sanitizeText';
import usePalette from './hooks/usePalette';
import { useLocalStorage } from './hooks/useStorage';
import Pinball from './Pinball';
import Progress from './Progress';
import Review from './Review';
import Setup from './Setup';
import { useSoopChat } from './SoopChatContext';
import type { DonationData, StoreType } from './types';

type DonationEvent =
  | SoopChatEventMap['sendBalloon']
  | SoopChatEventMap['adconEffect'];

const REGEXP = /\(\d+\)$/;

const App = () => {
  const pendingDonation = useRef(
    new Map<string, (DonationData & { timer: NodeJS.Timeout })[]>(),
  );
  const [tab, setTab] = useLocalStorage<StoreType['tab']>('tab', 0);
  const [, setDonationList] = useLocalStorage<
    StoreType['progress.donationList']
  >('progress.donationList', []);
  const [, setReview] = useLocalStorage<StoreType['review']>('review', {});

  const { chat } = useSoopChat();
  const theme = usePalette();
  const { enqueueSnackbar } = useSnackbar();

  // 도네이션 응답과 도네이션 전자녀(일반 텍스트) 응답이 따로 오기 때문에
  // 도네이션 응답을 받으면 일반 텍스트 응답을 기다렸다가 합친다.
  useEffect(() => {
    const handleDonation = (event: DonationEvent) => {
      const userId = event.data.senderId.replace(REGEXP, '');
      if (!pendingDonation.current.has(userId)) {
        pendingDonation.current.set(userId, []);
      }
      const queue = pendingDonation.current.get(userId) ?? [];
      const timer = setTimeout(() => {
        queue.shift();
        if (queue.length === 0) {
          pendingDonation.current.delete(userId);
        }
      }, 30000); // 메시지 시간 제한
      queue.push({
        receivedAt: new Date(event.receivedAt).toISOString(),
        type: event.type,
        amount: event.data.count,
        userId,
        username: event.data.senderNickname,
        message: '',
        timer,
      });
    };

    const sendBalloonOff = chat?.on('sendBalloon', (event) => {
      console.log(
        'sendBalloon',
        new Date(event.receivedAt).toLocaleString(),
        event.data,
      );
      handleDonation(event);
    });
    const adconEffectOff = chat?.on('adconEffect', (event) => {
      console.log(
        'adconEffect',
        new Date(event.receivedAt).toLocaleString(),
        event.data,
      );
      handleDonation(event);
    });
    return () => {
      sendBalloonOff?.();
      adconEffectOff?.();
    };
  }, [chat]);
  useEffect(
    () =>
      chat?.on('chatMessage', (event) => {
        console.log(
          'chatMessage',
          new Date(event.receivedAt).toLocaleString(),
          event.data,
        );
        const userId = event.data.senderId.replace(REGEXP, '');
        const queue = pendingDonation.current.get(userId) ?? [];
        if (queue.length > 0) {
          const donation = queue.shift();
          if (donation) {
            clearTimeout(donation.timer);
            const data = {
              receivedAt: donation.receivedAt,
              type: donation.type,
              amount: donation.amount,
              userId,
              username: event.data.senderNickname,
              message: event.data.message,
            };
            const calcResult = donationCalc(data); // 단가 계산
            if (calcResult) {
              setDonationList((oldDonationList) =>
                oldDonationList.concat(data),
              );
              const name = sanitizeText(calcResult.name);
              setReview((oldReview) => ({
                ...oldReview,
                [calcResult.price]: {
                  ...oldReview[calcResult.price],
                  [name]:
                    (oldReview[calcResult.price]?.[name] ?? 0) +
                    calcResult.amount,
                },
              }));
              enqueueSnackbar(`${name} ${calcResult.amount}개 추가됨`);
            }
          }
          if (queue.length === 0) {
            pendingDonation.current.delete(userId);
          }
        }
      }),
    [chat, setDonationList, setReview, enqueueSnackbar],
  );

  const handleChange = (_e: SyntheticEvent, v: number) => {
    setTab(v);
  };

  return (
    <ThemeProvider theme={theme}>
      <Container component="main" sx={{ p: 4 }}>
        <Navigation onChange={handleChange} value={tab}>
          <Setup />
          <Progress />
          <Review />
          <Pinball />
        </Navigation>
        <LinkDial />
      </Container>
    </ThemeProvider>
  );
};

export default App;
