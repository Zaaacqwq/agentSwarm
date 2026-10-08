import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders chat Markdown. Raw HTML is not enabled, so message text cannot inject markup. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
