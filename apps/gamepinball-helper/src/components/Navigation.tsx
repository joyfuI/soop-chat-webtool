import Looks3Icon from '@mui/icons-material/Looks3';
import Looks4Icon from '@mui/icons-material/Looks4';
import LooksOneIcon from '@mui/icons-material/LooksOne';
import LooksTwoIcon from '@mui/icons-material/LooksTwo';
import type { BottomNavigationProps } from '@mui/material/BottomNavigation';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import type { PropsWithChildren } from 'react';
import { Children } from 'react';

export type NavigationProps = PropsWithChildren<{
  value?: BottomNavigationProps['value'];
  onChange?: BottomNavigationProps['onChange'];
}>;

const Navigation = ({ children, value, onChange }: NavigationProps) => {
  return (
    <>
      <Box sx={{ pb: 7 }}>
        {Children.map(children, (child, index) => (
          <div hidden={value !== index} role="tabpanel">
            {child}
          </div>
        ))}
      </Box>

      <Paper
        elevation={3}
        sx={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}
      >
        <BottomNavigation onChange={onChange} showLabels value={value}>
          <BottomNavigationAction icon={<LooksOneIcon />} label="준비" />
          <BottomNavigationAction icon={<LooksTwoIcon />} label="진행" />
          <BottomNavigationAction icon={<Looks3Icon />} label="검토" />
          <BottomNavigationAction icon={<Looks4Icon />} label="핀볼" />
        </BottomNavigation>
      </Paper>
    </>
  );
};

export default Navigation;
