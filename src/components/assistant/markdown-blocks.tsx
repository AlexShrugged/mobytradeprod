import Link from "next/link";

import {
  parseAgentMarkdown,
  type InlineNode,
  type MarkdownBlock,
} from "@/lib/agent/markdown";

// Renders the assistant's markdown subset. Internal links become <Link>s;
// everything else was already reduced to inert text by the parser.

function Inlines({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "bold":
            return (
              <strong key={i} className="font-semibold">
                <Inlines nodes={node.inlines} />
              </strong>
            );
          case "code":
            return (
              <code
                key={i}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
              >
                {node.text}
              </code>
            );
          case "link":
            return (
              <Link
                key={i}
                href={node.href}
                className="font-medium text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
              >
                {node.label}
              </Link>
            );
          default:
            return <span key={i}>{node.text}</span>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "heading":
      return (
        <div className="pt-1 text-sm font-semibold">
          <Inlines nodes={block.inlines} />
        </div>
      );
    case "codeblock":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {block.text}
        </pre>
      );
    case "list":
      return block.ordered ? (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ul>
      );
    default:
      return (
        <p>
          <Inlines nodes={block.inlines} />
        </p>
      );
  }
}

export function MarkdownBlocks({ text }: { text: string }) {
  const blocks = parseAgentMarkdown(text);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
