import Backdrop from '@mui/material/Backdrop';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SoopChatEventMap } from 'soop-chat';

import useStore from './hooks/useStore';
import { useSoopChat } from './SoopChatContext';

type DonationEvent =
  | SoopChatEventMap['sendBalloon']
  | SoopChatEventMap['adconEffect'];

const RerollTimerApp = () => {
  const [step, setStep] = useState(0); // 0: 타이머 설정, 1: 타이머 시작, 2: 타이머 정지
  const [isReroll, setIsReroll] = useState(false);
  const timerEnd = useRef<number>(0);
  const timer = useRef<NodeJS.Timeout>(null);
  const [rerollPrice] = useStore('pinball.rerollPrice');
  const [minute, setMinute] = useStore('pinball.timer.minute');
  const [mm, setMM] = useState(() => minute);
  const [second, setSecond] = useStore('pinball.timer.second');
  const [ss, setSS] = useState(() => second);
  const [streamerId] = useStore('setup.streamerId');

  const { chat, connectChat } = useSoopChat();

  const interval = useCallback(() => {
    const remaining = Math.max(0, timerEnd.current - Date.now());
    const remainingSecond = Math.ceil(remaining / 1000);

    setMM(Math.floor(remainingSecond / 60));
    setSS(remainingSecond % 60);
  }, []);

  const handleClick = useCallback(() => {
    switch (step) {
      case 0:
        // 타이머 시작
        connectChat(streamerId).catch(console.error);
        timerEnd.current = Date.now() + (minute * 60 + second) * 1000; // 종료 시간
        timer.current = setInterval(interval, 250);
        setStep(1);
        break;

      case 1:
        // 타이머 정지
        chat?.disconnect();
        if (timer.current) {
          clearInterval(timer.current);
        }
        setStep(2);
        break;

      case 2:
        // 타이머 초기화
        setMM(minute);
        setSS(second);
        setStep(0);
        break;
    }
  }, [step, streamerId, minute, second, chat, connectChat, interval]);

  useEffect(() => {
    if (step === 1 && mm === 0 && ss === 0) {
      handleClick();
    }
  }, [step, mm, ss, handleClick]);

  useEffect(() => {
    const handleDonation = (e: DonationEvent) => {
      if (step === 1 && e.data.count === rerollPrice) {
        handleClick();
        setIsReroll(true);
      }
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
  }, [chat, step, rerollPrice, handleClick]);

  const handleMinuteChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10) || 0;
    setMinute(value);
    setMM(value);
  };

  const handleSecondChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10) || 0;
    setSecond(value);
    setSS(value);
  };

  const handleBackdropClick = () => {
    setIsReroll(false);
  };

  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        p: 2,
        overflow: 'hidden',
        alignContent: 'center',
      }}
    >
      <Typography gutterBottom variant="h5">
        리롤 {rerollPrice}개
      </Typography>
      <Stack direction="row" spacing={1}>
        <TextField
          disabled={step !== 0}
          fullWidth
          onChange={handleMinuteChange}
          slotProps={{
            htmlInput: { min: 0, max: 59, step: 1, inputMode: 'numeric' },
          }}
          sx={{ '& .MuiInputBase-input': { py: 1, fontSize: 30 } }}
          type="number"
          value={mm.toString().padStart(2, '0')}
          variant="outlined"
        />
        <Typography sx={{ alignSelf: 'center', fontSize: 30 }}>:</Typography>
        <TextField
          disabled={step !== 0}
          fullWidth
          onChange={handleSecondChange}
          slotProps={{
            htmlInput: { min: 0, max: 59, step: 1, inputMode: 'numeric' },
          }}
          sx={{ '& .MuiInputBase-input': { py: 1, fontSize: 30 } }}
          type="number"
          value={ss.toString().padStart(2, '0')}
          variant="outlined"
        />
        <Button onClick={handleClick} sx={{ minWidth: 80 }} variant="contained">
          {['시작', '정지', '초기화'][step]}
        </Button>
      </Stack>

      <Backdrop
        onClick={handleBackdropClick}
        open={isReroll}
        sx={{ backgroundColor: 'rgba(0, 0, 0, 0.9)', cursor: 'pointer' }}
      >
        <Typography sx={{ color: '#fff' }} variant="h3">
          리롤!!
        </Typography>
      </Backdrop>
    </Box>
  );
};

export default RerollTimerApp;
