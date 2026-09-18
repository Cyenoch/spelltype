import type { Child, ElProps } from './types';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.testid) node.dataset.testid = props.testid;
  if (props.type) node.setAttribute('type', props.type);
  if (props.value !== undefined) node.setAttribute('value', props.value);
  if (props.hidden) node.hidden = true;

  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [key, value] of Object.entries(props.data ?? {})) {
    if (value === null || value === undefined) continue;
    setData(node, key, value);
  }
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    if (!handler) continue;
    node.addEventListener(event, handler as EventListener);
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Write a `data-*` attribute. Dashed keys (`match-id`) are valid attributes but
 * invalid `dataset` property names, so attributes are written directly.
 */
export function setData(
  node: HTMLElement,
  key: string,
  value: string | number | boolean | null,
): void {
  const name = `data-${key}`;
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

export function setText(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function image(
  src: string,
  alt: string,
  className: string,
  fallback?: string,
): HTMLImageElement {
  const img = el('img', { class: className, attrs: { src, alt, decoding: 'async' } });
  if (fallback) {
    img.addEventListener('error', () => {
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = '1';
      img.src = fallback;
    });
  }
  return img;
}
