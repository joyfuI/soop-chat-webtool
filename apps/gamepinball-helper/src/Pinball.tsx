import FormLabel from '@joyfui/ui/FormLabel';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { ChangeEvent } from 'react';
import { useMemo } from 'react';

import useStore from './hooks/useStore';
import objectToFeatures from './utils/objectToFeatures';

const Pinball = () => {
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
    const width = 320;
    const height = 140;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

    const popup = window.open(
      '?window=reroll-timer',
      'reroll-timer',
      objectToFeatures({ popup: true, width, height, left, top }),
    );
    if (!popup) {
      alert('팝업을 허용해주세요.');
    }
  };

  return (
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
  );
};

export default Pinball;
