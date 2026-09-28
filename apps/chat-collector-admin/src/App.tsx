import CodeOutlined from '@mui/icons-material/CodeOutlined';
import LiveTvOutlined from '@mui/icons-material/LiveTvOutlined';
import ManageAccountsOutlined from '@mui/icons-material/ManageAccountsOutlined';
import StorageOutlined from '@mui/icons-material/StorageOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { apiBaseUrl, configurationError } from './api';
import Broadcasts from './Broadcasts';
import Query from './Query';
import Settings from './Settings';
import Streamers from './Streamers';

const tabs = [
  { label: '스트리머', icon: <StorageOutlined /> },
  { label: '방송', icon: <LiveTvOutlined /> },
  { label: 'SQL 조회', icon: <CodeOutlined /> },
  { label: 'SOOP 계정', icon: <ManageAccountsOutlined /> },
];

export default function App() {
  const [tab, setTab] = useState(0);
  const [revision, setRevision] = useState(0);
  const changed = () => setRevision((value) => value + 1);
  const props = { revision, onChanged: changed };
  const pages = configurationError
    ? []
    : [
        <Streamers active={tab === 0} {...props} />,
        <Broadcasts active={tab === 1} {...props} />,
        <Query active={tab === 2} revision={revision} />,
        <Settings active={tab === 3} {...props} />,
      ];

  return (
    <>
      <Box component="header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Container maxWidth="xl" sx={{ px: { xs: 2, md: 4 } }}>
          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Tabs
              aria-label="관리 메뉴"
              onChange={(_event, value: number) => setTab(value)}
              scrollButtons="auto"
              sx={{ flex: 1, minWidth: 0 }}
              value={tab}
              variant="scrollable"
            >
              {tabs.map(({ label, icon }, index) => (
                <Tab
                  aria-controls={`panel-${index}`}
                  icon={icon}
                  iconPosition="start"
                  id={`tab-${index}`}
                  key={label}
                  label={label}
                  sx={{ minHeight: 56, px: { xs: 1.5, sm: 3 } }}
                />
              ))}
            </Tabs>
            {!configurationError ? (
              <Typography
                color="text.secondary"
                sx={{ display: { xs: 'none', sm: 'block' } }}
                variant="body2"
              >
                API · {new URL(apiBaseUrl).host}
              </Typography>
            ) : null}
          </Stack>
        </Container>
      </Box>
      <Container
        component="main"
        maxWidth="xl"
        sx={{ px: { xs: 2, md: 4 }, py: { xs: 3, md: 5 } }}
      >
        {configurationError ? (
          <Alert severity="error">{configurationError}</Alert>
        ) : (
          pages.map((page, index) => (
            <Box
              aria-labelledby={`tab-${index}`}
              hidden={tab !== index}
              id={`panel-${index}`}
              key={tabs[index]?.label}
              role="tabpanel"
            >
              {page}
            </Box>
          ))
        )}
      </Container>
    </>
  );
}
