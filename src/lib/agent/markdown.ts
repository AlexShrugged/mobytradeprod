// Safe-subset markdown parser for assistant prose: paragraphs, headings,
// lists, fenced code, bold, inline code, and links. Internal links (href
// starting with "/") become Next <Link>s in the renderer; external URLs
// deliberately render as plain text - the assistant only ever needs to
// point inside the app. No HTML passthrough, no dependency. Pure.

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; label: string; href: string };

export type MarkdownBlock =
  | { type: "paragraph"; inlines: InlineNode[] }
  | { type: "heading"; level: number; inlines: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "codeblock"; text: string };

const INLINE_TOKEN =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^()\s]+\))/g;

/** Internal app paths only - anything else stays inert text. */
const isSafeInternalHref = (href: string): boolean =>
  href.startsWith("/") && !href.startsWith("//");

export function parseInlines(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) nodes.push({ type: "text", text: text.slice(last, index) });
    last = index + token.length;
    if (token.startsWith("**")) {
      nodes.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      nodes.push({ type: "code", text: token.slice(1, -1) });
    } else {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      if (isSafeInternalHref(href)) {
        nodes.push({ type: "link", label, href });
      } else {
        nodes.push({ type: "text", text: label });
      }
    }
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes;
}

const LIST_ITEM = /^(?:[-*]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

export function parseAgentMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      type: "paragraph",
      inlines: parseInlines(paragraph.join(" ").trim()),
    });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      type: "list",
      ordered: list.ordered,
      items: list.items.map(parseInlines),
    });
    list = null;
  };

  for (const line of lines) {
    if (code !== null) {
      if (line.trimEnd().startsWith("```")) {
        blocks.push({ type: "codeblock", text: code.join("\n") });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inlines: parseInlines(heading[2]),
      });
      continue;
    }
    const item = LIST_ITEM.exec(trimmed);
    if (item) {
      flushParagraph();
      const ordered = /^\d/.test(trimmed);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  if (code !== null) blocks.push({ type: "codeblock", text: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}
