export type Child = Node | string | number | null | undefined | false;

export type Handlers = {
  [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void;
};

export interface ElProps {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  testid?: string;
  type?: string;
  value?: string;
  hidden?: boolean;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string | number | boolean | null | undefined>;
  on?: Handlers;
}
