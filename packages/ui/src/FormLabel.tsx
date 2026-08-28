import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { PropsWithChildren, ReactNode } from 'react';

export type FormLabelProps = PropsWithChildren<{
  label: ReactNode;
  description?: ReactNode;
}>;

const FormLabel = ({ children, label, description }: FormLabelProps) => {
  return (
    <Box>
      <Typography gutterBottom variant="h6">
        {label}
      </Typography>
      {description ? (
        <Typography
          gutterBottom
          sx={{ display: 'block', whiteSpace: 'pre-wrap' }}
          variant="body2"
        >
          {description}
        </Typography>
      ) : null}
      {children}
    </Box>
  );
};

export default FormLabel;
