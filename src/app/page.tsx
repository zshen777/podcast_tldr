"use client";

import { useState, useRef, useCallback } from "react";

type Status = "idle" | "loading" | "streaming" | "done" | "error";

export default function Home() {
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.trim()) return;

      // Abort any previous request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSummary("");
      setError("");
      setStatus("loading");

      try {
        const res = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Something went wrong");
        }

        setStatus("streaming");
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response stream");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.error) throw new Error(parsed.error);
              if (parsed.text) {
                setSummary((prev) => prev + parsed.text);
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== line) {
                throw parseErr;
              }
            }
          }
        }

        setStatus("done");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Something went wrong");
        setStatus("error");
      }
    },
    [url]
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            Podcast TLDR
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Paste a YouTube URL, get a morning-friendly summary
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Input Form */}
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 px-4 py-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            disabled={status === "loading" || status === "streaming"}
          />
          <button
            type="submit"
            disabled={
              !url.trim() || status === "loading" || status === "streaming"
            }
            className="px-6 py-3 rounded-lg bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {status === "loading"
              ? "Fetching..."
              : status === "streaming"
                ? "Summarizing..."
                : "Summarize"}
          </button>
        </form>

        {/* Loading State */}
        {status === "loading" && (
          <div className="mt-8 flex items-center gap-3 text-zinc-500 dark:text-zinc-400">
            <Spinner />
            <span className="text-sm">
              Fetching transcript (this may take a minute if audio transcription is needed)...
            </span>
          </div>
        )}

        {/* Error State */}
        {status === "error" && error && (
          <div className="mt-8 p-4 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        {/* Summary Output */}
        {(status === "streaming" || status === "done") && (
          <article className="mt-8 prose prose-zinc dark:prose-invert prose-sm max-w-none bg-white dark:bg-zinc-800/50 rounded-lg border border-zinc-200 dark:border-zinc-700 p-6 shadow-sm">
            {status === "streaming" && !summary && (
              <div className="flex items-center gap-3 text-zinc-500 dark:text-zinc-400">
                <Spinner />
                <span className="text-sm">Generating summary...</span>
              </div>
            )}
            <MarkdownRenderer content={summary} />
            {status === "streaming" && (
              <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-0.5" />
            )}
          </article>
        )}

        {/* Empty State */}
        {status === "idle" && (
          <div className="mt-16 text-center text-zinc-400 dark:text-zinc-500">
            <div className="text-4xl mb-4">&#127911;</div>
            <p className="text-sm">
              Paste a YouTube podcast link above to get your TLDR
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  if (!content) return null;

  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listKey = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${listKey++}`} className="list-disc pl-5 space-y-1">
          {listItems.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      flushList();
      elements.push(
        <h3 key={i} className="text-base font-semibold mt-5 mb-2">
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith("## ")) {
      flushList();
      elements.push(
        <h2 key={i} className="text-lg font-bold mt-4 mb-2">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      listItems.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      elements.push(
        <p key={i} className="mb-2">
          {line}
        </p>
      );
    }
  }
  flushList();

  return <>{elements}</>;
}
