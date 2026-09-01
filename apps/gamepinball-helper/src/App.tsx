import Navigation from '@joyfui/ui/Navigation';
import Looks3Icon from '@mui/icons-material/Looks3';
import Looks4Icon from '@mui/icons-material/Looks4';
import LooksOneIcon from '@mui/icons-material/LooksOne';
import LooksTwoIcon from '@mui/icons-material/LooksTwo';
import Container from '@mui/material/Container';
import { useSnackbar } from 'notistack';
import type { SyntheticEvent } from 'react';
import { useEffect, useRef } from 'react';
import type { SoopChatEventMap } from 'soop-chat';

import LinkDial from './components/LinkDial';
import donationCalc from './helper/donationCalc';
import sanitizeText from './helper/sanitizeText';
import useChatState from './hooks/useChatState';
import useStore from './hooks/useStore';
import useUnload from './hooks/useUnload';
import Pinball from './Pinball';
import Progress from './Progress';
import Review from './Review';
import Setup from './Setup';
import { useSoopChat } from './SoopChatContext';
import type { DonationData } from './types';

type DonationEvent =
  | SoopChatEventMap['sendBalloon']
  | SoopChatEventMap['adconEffect'];

const REGEXP = /\(\d+\)$/;

const App = () => {
  const pendingDonation = useRef(
    new Map<string, (DonationData & { timer: NodeJS.Timeout })[]>(),
  );
  const [tab, setTab] = useStore('tab');
  const [priceList] = useStore('setup.priceList');
  const [, setDonationList] = useStore('progress.donationList');
  const [, setReview] = useStore('review');

  const { chat } = useSoopChat();
  const chatState = useChatState();
  const { enqueueSnackbar } = useSnackbar();

  // 도네이션 응답과 도네이션 전자녀(일반 텍스트) 응답이 따로 오기 때문에
  // 도네이션 응답을 받으면 일반 텍스트 응답을 기다렸다가 합친다.
  useEffect(() => {
    const handleDonation = (e: DonationEvent) => {
      const userId = e.data.senderId.replace(REGEXP, '');
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
        receivedAt: new Date(e.receivedAt).toISOString(),
        type: e.type,
        amount: e.data.count,
        userId,
        username: e.data.senderNickname,
        message: '',
        timer,
      });
    };

    const sendBalloonOff = chat?.on('sendBalloon', (e) => {
      console.log(
        'sendBalloon',
        new Date(e.receivedAt).toLocaleString(),
        e.data,
      );
      handleDonation(e);
    });
    const adconEffectOff = chat?.on('adconEffect', (e) => {
      console.log(
        'adconEffect',
        new Date(e.receivedAt).toLocaleString(),
        e.data,
      );
      handleDonation(e);
    });
    return () => {
      sendBalloonOff?.();
      adconEffectOff?.();
    };
  }, [chat]);
  useEffect(
    () =>
      chat?.on('chatMessage', (e) => {
        console.log(
          'chatMessage',
          new Date(e.receivedAt).toLocaleString(),
          e.data,
        );
        const userId = e.data.senderId.replace(REGEXP, '');
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
              username: e.data.senderNickname,
              message: e.data.message,
            };
            const calcResult = donationCalc(data, priceList); // 단가 계산
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
    [chat, priceList, setDonationList, setReview, enqueueSnackbar],
  );

  useUnload((e: BeforeUnloadEvent) => {
    if (chatState !== 'disconnected') {
      e.preventDefault();
      e.returnValue = true;
    }
  });

  const handleChange = (_e: SyntheticEvent, v: number) => {
    setTab(v);
  };

  return (
    <Container component="main" sx={{ p: 4 }}>
      <Navigation
        actions={[
          { icon: <LooksOneIcon />, label: '준비' },
          { icon: <LooksTwoIcon />, label: '진행' },
          { icon: <Looks3Icon />, label: '검토' },
          { icon: <Looks4Icon />, label: '핀볼' },
        ]}
        keepMounted
        onChange={handleChange}
        value={tab}
      >
        <Setup />
        <Progress />
        <Review />
        <Pinball />
      </Navigation>
      <LinkDial />
    </Container>
  );
};

export default App;
