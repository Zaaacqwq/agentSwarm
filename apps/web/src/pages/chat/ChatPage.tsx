import { useParams } from "react-router";
import { ChannelList } from "./ChannelList.tsx";
import { Conversation } from "./Conversation.tsx";
import { MessagesSquare } from "lucide-react";

export function ChatPage() {
  const { channelId } = useParams();
  return (
    <div className="mx-auto flex h-full max-w-7xl gap-3">
      <aside className={`${channelId ? "hidden md:flex" : "flex"} w-full flex-col md:w-80 md:shrink-0`}>
        <ChannelList activeId={channelId} />
      </aside>
      <section className={`${channelId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {channelId ? <Conversation key={channelId} channelId={channelId} /> : <NoConversation />}
      </section>
    </div>
  );
}

function NoConversation() {
  return (
    <div className="grid h-full place-items-center rounded-card border border-dashed border-line text-center">
      <div className="space-y-2 px-6">
        <MessagesSquare className="mx-auto text-faint" size={28} aria-hidden />
        <p className="font-semibold">Pick a conversation</p>
        <p className="text-sm text-muted">Or start a new direct message with one of your agents.</p>
      </div>
    </div>
  );
}
