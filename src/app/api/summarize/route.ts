import { NextRequest, NextResponse } from "next/server";
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

async function fetchTranscript(videoId: string): Promise<string> {
  // Fetch the YouTube watch page to extract captions info
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(watchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch YouTube page (status ${res.status})`);
  }

  const html = await res.text();

  // Extract captions data from the embedded player response
  // Find the captions JSON object by matching braces
  const captionsMarker = '"captions":';
  const markerIdx = html.indexOf(captionsMarker);
  if (markerIdx === -1) {
    throw new Error("No captions available for this video");
  }

  const startIdx = markerIdx + captionsMarker.length;
  let braceCount = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < html.length; i++) {
    if (html[i] === "{") braceCount++;
    if (html[i] === "}") braceCount--;
    if (braceCount === 0) {
      endIdx = i + 1;
      break;
    }
  }
  const captionsJson = html.slice(startIdx, endIdx);

  const captions = JSON.parse(captionsJson);
  const tracks =
    captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks || tracks.length === 0) {
    throw new Error("No caption tracks found for this video");
  }

  // Prefer English, fall back to first available track
  const englishTrack = tracks.find(
    (t: { languageCode: string }) =>
      t.languageCode === "en" || t.languageCode?.startsWith("en")
  );
  const track = englishTrack || tracks[0];
  const captionUrl = track.baseUrl;

  if (!captionUrl) {
    throw new Error("No caption URL found");
  }

  // Fetch the actual captions XML
  const captionRes = await fetch(captionUrl);
  if (!captionRes.ok) {
    throw new Error(`Failed to fetch captions (status ${captionRes.status})`);
  }

  const xml = await captionRes.text();

  // Parse text from XML <text> elements and decode HTML entities
  const textSegments = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
  if (!textSegments || textSegments.length === 0) {
    throw new Error("Transcript is empty");
  }

  const text = textSegments
    .map((segment) => {
      const content = segment.replace(/<[^>]+>/g, "");
      return content
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#\d+;/g, (match) => {
          const code = parseInt(match.slice(2, -1));
          return String.fromCharCode(code);
        })
        .trim();
    })
    .filter(Boolean)
    .join(" ");

  if (!text.trim()) {
    throw new Error("Transcript is empty");
  }

  return text;
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
        {
          error:
            "Could not extract video ID from the URL. Please provide a valid YouTube URL.",
        },
        { status: 400 }
      );
    }

    // Fetch transcript
    let fullTranscript: string;
    try {
      fullTranscript = await fetchTranscript(videoId);
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        {
          error: `Could not fetch transcript: ${detail}. The video may not have captions available.`,
        },
        { status: 422 }
      );
    }

    // Truncate very long transcripts to stay within context limits
    const maxChars = 100_000;
    const transcript =
      fullTranscript.length > maxChars
        ? fullTranscript.slice(0, maxChars) +
          "\n\n[Transcript truncated due to length]"
        : fullTranscript;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Anthropic API key not configured. Please set ANTHROPIC_API_KEY in your .env.local file.",
        },
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
              const chunk =
                JSON.stringify({ text: event.delta.text }) + "\n";
              controller.enqueue(encoder.encode(chunk));
            }
          }

          controller.close();
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : "Failed to generate summary";
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
