import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Fab from '@mui/material/Fab';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';

import useChatState from './hooks/useChatState';
import useStore from './hooks/useStore';
import { useSoopChat } from './SoopChatContext';

const Progress = () => {
  const [fontSize, setFontSize] = useStore('progress.fontSize');
  const [donationList] = useStore('progress.donationList');
  const [streamerId] = useStore('setup.streamerId');
  const [rule] = useStore('setup.rule');
  const theme = useTheme();

  const { chat, connectChat } = useSoopChat();
  const chatState = useChatState();

  const playSoopChat = async () => {
    try {
      await connectChat(streamerId);
    } catch (e) {
      console.error(e);
      if (e instanceof DOMException && e.name === 'AbortError') {
        // 사용자 취소
        return;
      }
      alert('채팅 연결 실패!');
    }
  };

  const stopSoopChat = () => {
    chat?.disconnect();
  };

  const handleFontSizeChange = (_e: Event, v: number) => {
    setFontSize(v);
  };

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ minWidth: 'fit-content' }} variant="body2">
          글자크기
        </Typography>
        <Slider
          max={120}
          min={20}
          onChange={handleFontSizeChange}
          size="small"
          value={fontSize}
          valueLabelDisplay="auto"
        />
        {chatState === 'disconnected' ? (
          <Fab
            color="primary"
            onClick={playSoopChat}
            sx={{ minWidth: 'fit-content' }}
            variant="extended"
          >
            <PlayArrowIcon sx={{ mr: 1 }} />
            시작!
          </Fab>
        ) : (
          <Fab
            color="secondary"
            onClick={stopSoopChat}
            sx={{ minWidth: 'fit-content' }}
            variant="extended"
          >
            <StopIcon sx={{ mr: 1 }} />
            정지
          </Fab>
        )}
      </Stack>

      <Typography
        sx={{
          fontSize,
          '& code': {
            backgroundColor: theme.alpha(theme.palette.primary.main, 0.2),
          },
        }}
      >
        단가에 맞춰서 <code>게임이름</code>으로 별풍선 쏘면 자동으로 추가됩니다.
        <br />
        여러 개를 넣고 싶으면 <code>게임이름*개수</code>로 정확한 개수를 넣어야
        합니다.
        <br />
        단가가 맞지 않은 별풍선은 무시됩니다.
      </Typography>
      <Divider />
      <Typography sx={{ fontSize, whiteSpace: 'pre-wrap' }}>{rule}</Typography>
      <Divider />

      <Typography gutterBottom>인식한 별풍선 목록</Typography>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
        {donationList.toReversed().map((donation) => (
          <Chip
            key={donation.receivedAt}
            label={donation.message}
            size="small"
          />
        ))}
      </Stack>
    </>
  );
};

export default Progress;
