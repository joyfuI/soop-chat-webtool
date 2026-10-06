import type { EmotionCache } from '@emotion/cache';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import FormLabel from '@joyfui/ui/FormLabel';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { ChangeEvent } from 'react';
import { useMemo, useState } from 'react';
import type { DocumentPictureInPictureEvent } from 'react-document-pip';
import DocumentPip from 'react-document-pip';

import useStore from './hooks/useStore';
import RerollTimerApp from './RerollTimerApp';
import { SoopChatProvider } from './SoopChatContext';
import objectToFeatures from './utils/objectToFeatures';

const POPUP_WIDTH = 320;
const POPUP_HEIGHT = 140;

const Pinball = () => {
  const [open, setOpen] = useState(false);
  const [pipCache, setPipCache] = useState<EmotionCache | null>(null);
  const [rerollPrice, setRerollPrice] = useStore('pinball.rerollPrice');
  const [review] = useStore('review');
  const [priceList] = useStore('setup.priceList');

  const value = useMemo(
    () =>
      priceList
        .reduce<string[]>(
          (prev, curr) =>
            prev.concat(
              Object.entries(review[curr.toString()] ?? {}).map(
                ([name, amount]) => `${name}*${amount}`,
              ),
            ),
          [],
        )
        .join(','),
    [review, priceList],
  );

  const handleRerollPriceChange = (e: ChangeEvent<HTMLInputElement>) => {
    setRerollPrice(parseInt(e.target.value, 10) || 0);
  };

  const handleOpenClick = () => {
    if ('documentPictureInPicture' in window) {
      setOpen(true);
    } else {
      const left = Math.round(
        window.screenX + (window.outerWidth - POPUP_WIDTH) / 2,
      );
      const top = Math.round(
        window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2,
      );

      const popup = window.open(
        '?window=reroll-timer',
        'reroll-timer',
        objectToFeatures({
          popup: true,
          width: POPUP_WIDTH,
          height: POPUP_HEIGHT,
          left,
          top,
        }),
      );
      if (!popup) {
        alert('팝업을 허용해주세요.');
      }
    }
  };

  const handleClose = () => {
    setOpen(false);
    setPipCache(null);
  };

  const handleEnter = ({
    window: pipWindow,
  }: DocumentPictureInPictureEvent) => {
    setPipCache(
      createCache({ key: 'pip', container: pipWindow.document.head }),
    );
  };

  return (
    <>
      <Stack spacing={2}>
        <TextField
          fullWidth
          multiline
          slotProps={{ input: { readOnly: true } }}
          value={value}
          variant="outlined"
        />

        <Button
          endIcon={<OpenInNewIcon />}
          href={`https://lazygyu.github.io/roulette/?names=${encodeURIComponent(value)}`}
          rel="noreferrer"
          size="large"
          sx={{ alignSelf: 'self-start' }}
          target="_blank"
          variant="contained"
        >
          핀볼 사이트 열기
        </Button>

        <Stack direction="row" spacing={2}>
          <FormLabel label="전투3">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              height="315"
              referrerPolicy="strict-origin-when-cross-origin"
              src="https://www.youtube-nocookie.com/embed/tbMIHckT5No?playlist=tbMIHckT5No&loop=1"
              title="YouTube video player"
              width="560"
            ></iframe>
          </FormLabel>
          <FormLabel label="블루점프 '도전'">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              height="315"
              referrerPolicy="strict-origin-when-cross-origin"
              src="https://www.youtube-nocookie.com/embed/fEczS_A3r3E?playlist=fEczS_A3r3E&loop=1"
              title="YouTube video player"
              width="560"
            ></iframe>
          </FormLabel>
        </Stack>

        <FormLabel label="리롤 단가">
          <Stack direction="row" spacing={1}>
            <TextField
              onChange={handleRerollPriceChange}
              slotProps={{
                htmlInput: { min: 0, step: 100, inputMode: 'numeric' },
              }}
              type="number"
              value={rerollPrice}
              variant="standard"
            />
            <Button
              endIcon={<OpenInNewIcon />}
              onClick={handleOpenClick}
              variant="outlined"
            >
              리롤 타이머 열기
            </Button>
          </Stack>
        </FormLabel>
      </Stack>

      <DocumentPip
        disallowReturnToOpener
        isPipOpen={open}
        mode="transfer-only"
        onClose={handleClose}
        onEnter={handleEnter}
        preferInitialWindowPlacement
        size={{ width: POPUP_WIDTH, height: POPUP_HEIGHT }}
      >
        {pipCache ? (
          <CacheProvider value={pipCache}>
            <SoopChatProvider>
              <RerollTimerApp />
            </SoopChatProvider>
          </CacheProvider>
        ) : null}
      </DocumentPip>
    </>
  );
};

export default Pinball;
