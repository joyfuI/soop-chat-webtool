import FormLabel from '@joyfui/ui/FormLabel';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { ChangeEvent } from 'react';

import PriceList from './components/PriceList';
import useChatState from './hooks/useChatState';
import { useLocalStorage } from './hooks/useStorage';
import { useSoopChat } from './SoopChatContext';
import type { StoreType } from './types';

const Setup = () => {
  const [streamerId, setStreamerId] = useLocalStorage<
    StoreType['setup.streamerId']
  >('setup.streamerId', '');
  const [rule, setRule] = useLocalStorage<StoreType['setup.rule']>(
    'setup.rule',
    '',
  );
  const [priceList, setPriceList] = useLocalStorage<
    StoreType['setup.priceList']
  >('setup.priceList', [50, 200]);

  const { chat } = useSoopChat();
  const chatState = useChatState();

  const handleAdd = (value: number) => {
    if (!Number.isNaN(value) && value >= 0) {
      setPriceList((oldValue) => {
        const set = new Set(oldValue);
        set.add(value);
        return Array.from(set).sort((a, b) => a - b);
      });
    }
  };

  const handleDelete = (value: number) => {
    setPriceList((oldValue) => oldValue.filter((item) => item !== value));
  };

  const handleIdChange = (e: ChangeEvent<HTMLInputElement>) => {
    setStreamerId(e.target.value);
  };

  const handleRuleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setRule(e.target.value);
  };

  const handlePinballResetClick = () => {
    chat?.disconnect();
    window.localStorage.removeItem('progress.donationList');
    window.localStorage.removeItem('review');
    window.location.reload();
  };

  const handleAllResetClick = () => {
    chat?.disconnect();
    window.localStorage.clear();
    window.location.reload();
  };

  return (
    <Stack spacing={2}>
      <FormLabel
        description="채팅을 연결할 스트리머의 SOOP ID를 입력하세요."
        label="SOOP ID"
      >
        <TextField
          disabled={chatState !== 'disconnected'}
          onChange={handleIdChange}
          value={streamerId}
          variant="outlined"
        />
      </FormLabel>

      <FormLabel
        description="진행 화면에 띄울 텍스트를 입력하세요."
        label="핀볼 규칙"
      >
        <TextField
          fullWidth
          maxRows={10}
          minRows={4}
          multiline
          onChange={handleRuleChange}
          value={rule}
          variant="outlined"
        />
      </FormLabel>

      <FormLabel
        description="단가를 설정하세요. 설정한 단가의 별풍선만 기록됩니다."
        label="핀볼 단가"
      >
        <PriceList data={priceList} onAdd={handleAdd} onDelete={handleDelete} />
      </FormLabel>

      <FormLabel
        description="모든 설정은 실시간으로 저장됩니다. 처음부터 하고 싶으면 초기화 버튼을 누르세요."
        label="초기화"
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
          <Button
            color="warning"
            onClick={handlePinballResetClick}
            size="large"
            variant="contained"
          >
            별풍선(핀볼)만 초기화
          </Button>
          <Button
            color="error"
            onClick={handleAllResetClick}
            size="small"
            variant="contained"
          >
            전체 초기화
          </Button>
        </Stack>
      </FormLabel>
    </Stack>
  );
};

export default Setup;
