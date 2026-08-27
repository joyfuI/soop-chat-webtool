import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import RemoveIcon from '@mui/icons-material/Remove';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import type { ChangeEvent } from 'react';
import { useState } from 'react';

import type { StoreType } from '../types';

export type PinballListProps = {
  price: keyof StoreType['review'];
  data: StoreType['review'][string];
  onAdd: (
    price: keyof StoreType['review'],
    value: keyof StoreType['review'][string],
  ) => void;
  onDelete: (
    price: keyof StoreType['review'],
    value: keyof StoreType['review'][string],
  ) => void;
  onPlus: (
    price: keyof StoreType['review'],
    value: keyof StoreType['review'][string],
  ) => void;
  onMinus: (
    price: keyof StoreType['review'],
    value: keyof StoreType['review'][string],
  ) => void;
};

const PinballList = ({
  price,
  data,
  onAdd,
  onDelete,
  onPlus,
  onMinus,
}: PinballListProps) => {
  const [value, setValue] = useState('');

  const handleAdd = () => {
    onAdd(price, value);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  };

  return (
    <Paper sx={{ minWidth: 340 }}>
      <List
        disablePadding
        subheader={<ListSubheader>{`단가 ${price}개`}</ListSubheader>}
      >
        {Object.entries(data).map(([name, amount]) => {
          const handlePlus = () => {
            onPlus(price, name);
          };

          const handleMinus = () => {
            onMinus(price, name);
          };

          const handleDelete = () => {
            onDelete(price, name);
          };

          return (
            <ListItem key={name}>
              <ListItemText primary={`${name}*${amount}`} />
              <ButtonGroup size="small" sx={{ ml: 1 }}>
                <Button onClick={handlePlus}>
                  <AddIcon />
                </Button>
                <Button onClick={handleMinus}>
                  <RemoveIcon />
                </Button>
                <Button onClick={handleDelete}>
                  <DeleteIcon />
                </Button>
              </ButtonGroup>
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
            value={value}
            variant="standard"
          />
        </ListItem>
      </List>
    </Paper>
  );
};

export default PinballList;
