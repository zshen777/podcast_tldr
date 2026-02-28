import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import Anthropic from "@anthropic-ai/sdk";

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

const SYSTEM_PROMPT = `You are an expert podcast and video summarizer. Your job is to create a concise, well-structured TLDR summary that someone can read in 2-3 minutes over their morning coffee.

Output your summary in the following format:

## [Video Title / Topic]

### TLDR (1-2 sentences)
A single, punchy summary of the entire conversation.

### Key Takeaways
- Bullet points of the most important insights (5-8 bullets max)

### Notable Quotes & Moments
- Any particularly memorable quotes or surprising moments

### Topics Covered
A brief list of the main topics discussed, in order.

### Who Should Watch This?
One sentence describing who would benefit most from the full video.

Rules:
- Be concise but don't lose nuance
- Capture the most interesting and actionable insights
- Use plain language, avoid jargon unless the podcast is technical
- If speakers are identifiable from context, attribute key points to them
- Focus on what's NEW or INTERESTING, skip generic filler`;

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { error: "Please provide a valid YouTube URL" },
        { status: 400 }
      );
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return NextResponse.json(
        { error: "Could not extract video ID from the URL. Please provide a valid YouTube URL." },
        { status: 400 }
      );
    }

    // Fetch transcript
    let transcriptItems;
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    } catch {
      return NextResponse.json(
        { error: "Could not fetch transcript. The video may not have captions available, or the URL may be invalid." },
        { status: 422 }
      );
    }

    if (!transcriptItems || transcriptItems.length === 0) {
      return NextResponse.json(
        { error: "No transcript found for this video." },
        { status: 422 }
      );
    }

    const fullTranscript = transcriptItems
      .map((item) => item.text)
      .join(" ");

    // Truncate very long transcripts to stay within context limits
    const maxChars = 100_000;
    const transcript =
      fullTranscript.length > maxChars
        ? fullTranscript.slice(0, maxChars) + "\n\n[Transcript truncated due to length]"
        : fullTranscript;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Please set ANTHROPIC_API_KEY in your .env.local file." },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });

    // Stream the response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = client.messages.stream({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: `Here is the transcript of a YouTube video/podcast. Please create a TLDR summary:\n\n${transcript}`,
              },
            ],
          });

          for await (const event of response) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const chunk = JSON.stringify({ text: event.delta.text }) + "\n";
              controller.enqueue(encoder.encode(chunk));
            }
          }

          controller.close();
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to generate summary";
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: message }) + "\n")
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    );
  }
}
