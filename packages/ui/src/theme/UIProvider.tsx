import CssBaseline from '@mui/material/CssBaseline';
import type { ThemeOptions } from '@mui/material/styles';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { deepmerge } from '@mui/utils';
import type { PropsWithChildren } from 'react';
import { useMemo } from 'react';

export type UIProviderProps = PropsWithChildren<{
  themeOptions?: ThemeOptions;
}>;

const defaultTheme = {
  colorSchemes: { light: true, dark: true },
  cssVariables: true,
  typography: {
    fontFamily:
      '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, "Helvetica Neue", "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif',
  },
  components: {
    MuiCssBaseline: { styleOverrides: { iframe: { border: 'none' } } },
    MuiStack: { defaultProps: { useFlexGap: true } },
  },
};

const UIProvider = ({ children, themeOptions }: UIProviderProps) => {
  const theme = useMemo(
    () => createTheme(deepmerge(defaultTheme, themeOptions)),
    [themeOptions],
  );

  return (
    <ThemeProvider noSsr theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
};

export default UIProvider;
