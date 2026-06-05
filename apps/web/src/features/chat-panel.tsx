import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ArrowUp } from "lucide-react";
import { Streamdown } from "streamdown";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app.store";

const EXAMPLE_QUESTIONS = [
  "How much did I spend on groceries last month?",
  "What was my biggest purchase in March?",
  "Am I spending more than usual this month?",
];

/** Concatenate the text parts of a UI message into a single string. */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Chat shell over `useChat`. The `DefaultChatTransport` targets `/ai/chat`
 * (proxied to the API in dev), sends `credentials: "include"` so the
 * SuperTokens session cookie is attached, and resolves the request body from a
 * callback so the latest `conversationId` is always sent. We never send a
 * `userId` — the server derives it from the session.
 */
export function ChatPanel() {
  const conversationId = useAppStore((s) => s.conversationId);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/ai/chat",
      credentials: "include",
      body: () => ({ conversationId }),
    }),
  });

  const isStreaming = status === "streaming" || status === "submitted";

  // Keep the view pinned to the latest message as the stream grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(input);
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0 px-1">
        {isEmpty ? (
          <div className="flex flex-col gap-3 py-8 text-sm text-muted-foreground">
            <p>Ask WalletWise about your spending. For example:</p>
            <div className="flex flex-col gap-2">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => submit(q)}
                  disabled={isStreaming}
                  className="rounded-md border bg-card px-3 py-2 text-left text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  {message.role === "user" ? (
                    // User text is plain — preserve their line breaks, no markdown.
                    <span className="whitespace-pre-wrap">{messageText(message)}</span>
                  ) : (
                    // Assistant replies are markdown (bold, bullets, tables, headings).
                    // Streamdown renders them safely even while the stream is mid-token.
                    // Tailwind's preflight strips list markers/heading sizes, so the
                    // arbitrary-variant classes below restore readable formatting.
                    <Streamdown
                      className={cn(
                        "size-full leading-relaxed",
                        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                        "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5",
                        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
                        "[&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold",
                        "[&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold",
                        "[&_h3]:font-semibold [&_strong]:font-semibold",
                        "[&_a]:underline [&_a]:underline-offset-2",
                        "[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]",
                        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2",
                        "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs",
                        "[&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
                        "[&_td]:border-t [&_td]:border-black/10 [&_td]:px-2 [&_td]:py-1",
                      )}
                    >
                      {messageText(message)}
                    </Streamdown>
                  )}
                </div>
              </div>
            ))}
            {error ? (
              <p className="text-sm text-destructive">
                Something went wrong. Please try again.
              </p>
            ) : null}
          </div>
        )}
      </ScrollArea>

      <form
        className="flex items-end gap-2 border-t pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your spending…"
          rows={1}
          className="min-h-[44px] flex-1 resize-none"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!input.trim() || isStreaming}
          aria-label="Send"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
