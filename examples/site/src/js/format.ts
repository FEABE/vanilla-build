export interface Item {
  name: string;
  done: boolean;
}

export function label(item: Item): string {
  return (item.done ? '[x] ' : '[ ] ') + item.name;
}
