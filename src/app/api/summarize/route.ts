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

function extractJsonObject(html: string, marker: string): string | null {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;

  const startIdx = markerIdx + marker.length;
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
  return html.slice(startIdx, endIdx);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#\d+;/g, (match) => {
      const code = parseInt(match.slice(2, -1));
      return String.fromCharCode(code);
    });
}

async function fetchYouTubePageHtml(videoId: string): Promise<string> {
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

  return res.text();
}

function tryExtractCaptionsTranscript(html: string): string | null {
  const captionsJson = extractJsonObject(html, '"captions":');
  if (!captionsJson) return null;

  try {
    const captions = JSON.parse(captionsJson);
    const tracks =
      captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks || tracks.length === 0) return null;

    const englishTrack = tracks.find(
      (t: { languageCode: string }) =>
        t.languageCode === "en" || t.languageCode?.startsWith("en")
    );
    const track = englishTrack || tracks[0];
    return track.baseUrl || null;
  } catch {
    return null;
  }
}

async function fetchCaptionsFromUrl(captionUrl: string): Promise<string> {
  const captionRes = await fetch(captionUrl);
  if (!captionRes.ok) {
    throw new Error(`Failed to fetch captions (status ${captionRes.status})`);
  }

  const xml = await captionRes.text();
  const textSegments = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
  if (!textSegments || textSegments.length === 0) {
    throw new Error("Transcript is empty");
  }

  const text = textSegments
    .map((segment) => {
      const content = segment.replace(/<[^>]+>/g, "");
      return decodeHtmlEntities(content).trim();
    })
    .filter(Boolean)
    .join(" ");

  if (!text.trim()) {
    throw new Error("Transcript is empty");
  }

  return text;
}

function extractAudioStreamUrl(html: string): string | null {
  // Extract adaptiveFormats from YouTube's player response
  const playerMatch = html.match(/"adaptiveFormats":\s*(\[[\s\S]*?\])/);
  if (!playerMatch) return null;

  try {
    const formats = JSON.parse(playerMatch[1]);
    // Find an audio-only format (prefer mp4a/webm audio)
    const audioFormat = formats.find(
      (f: { mimeType?: string; url?: string }) =>
        f.mimeType?.startsWith("audio/") && f.url
    );
    return audioFormat?.url || null;
  } catch {
    return null;
  }
}

async function transcribeWithAssemblyAI(audioUrl: string): Promise<string> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No captions available and ASSEMBLYAI_API_KEY is not configured for audio transcription fallback."
    );
  }

  // Submit transcription job
  const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audio_url: audioUrl }),
  });

  if (!submitRes.ok) {
    throw new Error(
      `AssemblyAI submission failed (status ${submitRes.status})`
    );
  }

  const { id } = await submitRes.json();

  // Poll for completion (max ~5 minutes)
  const pollUrl = `https://api.assemblyai.com/v2/transcript/${id}`;
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: apiKey },
    });

    if (!pollRes.ok) continue;

    const result = await pollRes.json();

    if (result.status === "completed") {
      if (!result.text?.trim()) {
        throw new Error("Transcription returned empty text");
      }
      return result.text;
    }

    if (result.status === "error") {
      throw new Error(
        `Transcription failed: ${result.error || "unknown error"}`
      );
    }
  }

  throw new Error("Transcription timed out");
}

async function fetchTranscript(videoId: string): Promise<string> {
  const html = await fetchYouTubePageHtml(videoId);

  // Strategy 1: Try YouTube's existing captions (fast, free)
  const captionUrl = tryExtractCaptionsTranscript(html);
  if (captionUrl) {
    try {
      return await fetchCaptionsFromUrl(captionUrl);
    } catch {
      // Fall through to audio transcription
    }
  }

  // Strategy 2: Extract audio stream URL and transcribe with AssemblyAI
  const audioUrl = extractAudioStreamUrl(html);
  if (!audioUrl) {
    throw new Error(
      "Could not find captions or audio stream for this video"
    );
  }

  return transcribeWithAssemblyAI(audioUrl);
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
          error: `Could not fetch transcript: ${detail}`,
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
