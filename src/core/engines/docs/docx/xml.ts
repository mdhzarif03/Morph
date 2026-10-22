import { XMLParser } from 'fast-xml-parser';

/** A node of fast-xml-parser's order-preserving tree: `{ 'w:p': [children], ':@': { '@_w:val': '1' } }`. */
export type XNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

export const parseXml = (text: string): XNode[] => parser.parse(text) as XNode[];

export const tagOf = (node: XNode): string => Object.keys(node).find((k) => k !== ':@') ?? '';

export function kids(node: XNode | undefined): XNode[] {
  if (!node) return [];
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

export const attrs = (node: XNode | undefined): Record<string, string> => (node?.[':@'] as Record<string, string> | undefined) ?? {};
export const attr = (node: XNode | undefined, name: string): string | undefined => attrs(node)[`@_${name}`];
export const child = (node: XNode | undefined, tag: string): XNode | undefined => kids(node).find((k) => tagOf(k) === tag);
export const children = (node: XNode | undefined, tag: string): XNode[] => kids(node).filter((k) => tagOf(k) === tag);
export const rootOf = (nodes: XNode[], tag: string): XNode | undefined => nodes.find((n) => tagOf(n) === tag);

export function textOf(node: XNode | undefined): string {
  return kids(node)
    .map((k) => ('#text' in k ? String(k['#text']) : ''))
    .join('');
}

/** Depth-first search for the first descendant with the given tag. */
export function findDeep(node: XNode | undefined, tag: string, maxDepth = 40): XNode | undefined {
  if (!node || maxDepth < 0) return undefined;
  for (const k of kids(node)) {
    if (tagOf(k) === tag) return k;
    const found = findDeep(k, tag, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

/** Word on/off properties: present without a value (or 1/true/on) means on; 0/false/off means off. */
export function onOff(node: XNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const v = attr(node, 'w:val');
  if (v === undefined) return true;
  return !['0', 'false', 'off'].includes(v.toLowerCase());
}
