import type { BottomNavigationProps } from '@mui/material/BottomNavigation';
import BottomNavigation from '@mui/material/BottomNavigation';
import type { BottomNavigationActionProps } from '@mui/material/BottomNavigationAction';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import type { PropsWithChildren } from 'react';
import { Children } from 'react';

export type NavigationProps = PropsWithChildren<{
  actions: BottomNavigationActionProps[];
  value?: BottomNavigationProps['value'];
  keepMounted?: boolean;
  onChange?: BottomNavigationProps['onChange'];
}>;

const Navigation = ({
  children,
  actions,
  value,
  keepMounted,
  onChange,
}: NavigationProps) => {
  return (
    <>
      <Box sx={{ pb: 7 }}>
        {Children.map(children, (child, index) =>
          keepMounted ? (
            <div hidden={value !== index} role="tabpanel">
              {child}
            </div>
          ) : value === index ? (
            child
          ) : null,
        )}
      </Box>

      <Paper
        elevation={3}
        sx={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}
      >
        <BottomNavigation onChange={onChange} showLabels value={value}>
          {actions.map((action, i) => (
            <BottomNavigationAction key={action.key ?? i} {...action} />
          ))}
        </BottomNavigation>
      </Paper>
    </>
  );
};

export default Navigation;
