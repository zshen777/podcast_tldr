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

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode: string;
      }>;
    };
  };
  streamingData?: {
    adaptiveFormats?: Array<{
      mimeType?: string;
      url?: string;
    }>;
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
}

// Extract a JSON object from a string starting at the first { after marker
function extractJsonFromString(text: string, marker: string): string | null {
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return null;

  // Find the first { after the marker
  let startIdx = -1;
  for (let i = markerIdx + marker.length; i < text.length; i++) {
    if (text[i] === "{") {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  // Match braces to find the complete JSON object
  let braceCount = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === "{") braceCount++;
    if (text[i] === "}") braceCount--;
    if (braceCount === 0) {
      return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function hasUsefulData(data: PlayerResponse): boolean {
  const hasCaptions =
    (data.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ??
      0) > 0;
  const hasStreaming =
    (data.streamingData?.adaptiveFormats?.length ?? 0) > 0;
  return hasCaptions || hasStreaming;
}

// Collect diagnostic info for debugging failures
const diagnostics: string[] = [];

// Strategy A: Fetch the watch page HTML with consent-bypass cookies
async function fetchPlayerFromWatchPage(
  videoId: string
): Promise<PlayerResponse | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie:
            "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnOlwY; CONSENT=PENDING+999",
        },
      }
    );

    if (!res.ok) {
      diagnostics.push(`WatchPage: HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();
    diagnostics.push(`WatchPage: got ${html.length} chars`);

    // Check for consent/bot pages
    if (
      html.includes("consent.youtube.com") ||
      html.includes("accounts.google.com")
    ) {
      diagnostics.push("WatchPage: consent/login redirect detected");
    }

    // Try to extract ytInitialPlayerResponse using brace-matching
    const markers = [
      "var ytInitialPlayerResponse =",
      "ytInitialPlayerResponse =",
    ];

    for (const marker of markers) {
      const jsonStr = extractJsonFromString(html, marker);
      if (jsonStr) {
        try {
          const data: PlayerResponse = JSON.parse(jsonStr);
          diagnostics.push(
            `WatchPage: parsed ${marker} (captions: ${!!data.captions}, streaming: ${!!data.streamingData})`
          );
          if (hasUsefulData(data)) return data;
        } catch (e) {
          diagnostics.push(
            `WatchPage: JSON parse failed for ${marker}: ${e instanceof Error ? e.message : "unknown"}`
          );
        }
      }
    }

    // Also look for captions data directly in the page
    const captionsJson = extractJsonFromString(html, '"captions":');
    if (captionsJson) {
      try {
        const captions = JSON.parse(captionsJson);
        diagnostics.push("WatchPage: found inline captions object");
        return { captions } as PlayerResponse;
      } catch {
        diagnostics.push("WatchPage: inline captions parse failed");
      }
    }

    diagnostics.push("WatchPage: no player data found in HTML");
    return null;
  } catch (e) {
    diagnostics.push(
      `WatchPage: fetch error: ${e instanceof Error ? e.message : "unknown"}`
    );
    return null;
  }
}

// Strategy B: Use innertube player API with different client types
async function fetchPlayerFromInnertubeApi(
  videoId: string
): Promise<PlayerResponse | null> {
  const clients = [
    {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
    },
    {
      clientName: "ANDROID",
      clientVersion: "19.09.37",
      androidSdkVersion: 30,
    },
    {
      clientName: "IOS",
      clientVersion: "19.09.3",
    },
    {
      clientName: "WEB",
      clientVersion: "2.20240313.05.00",
    },
  ];

  for (const clientConfig of clients) {
    try {
      const res = await fetch(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                ...clientConfig,
                hl: "en",
                gl: "US",
              },
            },
          }),
        }
      );

      if (!res.ok) {
        diagnostics.push(
          `Innertube ${clientConfig.clientName}: HTTP ${res.status}`
        );
        continue;
      }

      const data: PlayerResponse = await res.json();
      const status = data.playabilityStatus?.status || "unknown";
      diagnostics.push(
        `Innertube ${clientConfig.clientName}: status=${status}, captions=${!!data.captions}, streaming=${!!data.streamingData}`
      );

      if (hasUsefulData(data)) return data;
    } catch (e) {
      diagnostics.push(
        `Innertube ${clientConfig.clientName}: error: ${e instanceof Error ? e.message : "unknown"}`
      );
    }
  }

  return null;
}

async function fetchPlayerData(videoId: string): Promise<PlayerResponse> {
  diagnostics.length = 0;

  // Try watch page first (most reliable for getting captions)
  const fromPage = await fetchPlayerFromWatchPage(videoId);
  if (fromPage) return fromPage;

  // Try innertube API with various clients
  const fromApi = await fetchPlayerFromInnertubeApi(videoId);
  if (fromApi) return fromApi;

  throw new Error(
    "Could not retrieve video data from YouTube. Debug info: " +
      diagnostics.join(" | ")
  );
}

function extractCaptionUrl(player: PlayerResponse): string | null {
  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) return null;

  const englishTrack = tracks.find(
    (t) => t.languageCode === "en" || t.languageCode?.startsWith("en")
  );
  return (englishTrack || tracks[0]).baseUrl || null;
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

function extractAudioStreamUrl(player: PlayerResponse): string | null {
  const formats = player.streamingData?.adaptiveFormats;
  if (!formats) return null;

  const audioFormat = formats.find(
    (f) => f.mimeType?.startsWith("audio/") && f.url
  );
  return audioFormat?.url || null;
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
  const player = await fetchPlayerData(videoId);

  // Check if video is playable
  if (
    player.playabilityStatus?.status === "ERROR" ||
    player.playabilityStatus?.status === "UNPLAYABLE"
  ) {
    throw new Error(
      player.playabilityStatus.reason || "Video is not available"
    );
  }

  // Strategy 1: Try YouTube's existing captions (fast, free)
  const captionUrl = extractCaptionUrl(player);
  if (captionUrl) {
    try {
      return await fetchCaptionsFromUrl(captionUrl);
    } catch {
      // Fall through to audio transcription
    }
  }

  // Strategy 2: Extract audio stream URL and transcribe with AssemblyAI
  const audioUrl = extractAudioStreamUrl(player);
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
