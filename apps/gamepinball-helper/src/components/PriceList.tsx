import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import type { ChangeEvent } from 'react';
import { useState } from 'react';

import type { StoreType } from '../types';

export type PriceListProps = {
  data: StoreType['setup.priceList'];
  onAdd: (value: StoreType['setup.priceList'][number]) => void;
  onDelete: (value: StoreType['setup.priceList'][number]) => void;
};

const PriceList = ({ data, onAdd, onDelete }: PriceListProps) => {
  const [value, setValue] = useState('');

  const handleAdd = () => {
    onAdd(parseInt(value, 10));
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  };

  return (
    <Paper sx={{ width: 200 }}>
      <List disablePadding>
        {data.map((item) => {
          const handleDelete = () => {
            onDelete(item);
          };

          return (
            <ListItem
              key={item}
              secondaryAction={
                <IconButton edge="end" onClick={handleDelete}>
                  <ClearIcon />
                </IconButton>
              }
            >
              <ListItemText primary={`별풍선 ${item}개`} />
            </ListItem>
          );
        })}
        <Divider />
        <ListItem
          secondaryAction={
            <IconButton edge="end" onClick={handleAdd}>
              <AddIcon />
            </IconButton>
          }
        >
          <TextField
            fullWidth
            onChange={handleChange}
            slotProps={{
              htmlInput: { min: 0, step: 10, inputMode: 'numeric' },
            }}
            type="number"
            value={value}
            variant="standard"
          />
        </ListItem>
      </List>
    </Paper>
  );
};

export default PriceList;
