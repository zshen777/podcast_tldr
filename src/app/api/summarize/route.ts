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

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie:
    "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnOlwY; CONSENT=PENDING+999",
};

// Extract a JSON object from a string starting at the first { after marker
function extractJsonObject(text: string, marker: string): string | null {
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return null;

  let startIdx = -1;
  for (let i = markerIdx + marker.length; i < text.length; i++) {
    if (text[i] === "{") {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

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

function parseXmlTranscript(xml: string): string {
  const textSegments = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
  if (!textSegments || textSegments.length === 0) {
    throw new Error("Transcript XML is empty");
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

// Collect diagnostic info for debugging failures
const diagnostics: string[] = [];

// Strategy 0 (Primary): Use Invidious API instances to fetch captions.
// These are open-source YouTube frontends that run on servers designed
// to handle YouTube's datacenter IP blocking.
const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.projectsegfau.lt",
  "https://vid.puffyan.us",
  "https://invidious.privacyredirect.com",
  "https://iv.nbofc.de",
];

async function fetchTranscriptViaInvidious(
  videoId: string
): Promise<string | null> {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      // First, get the list of available caption tracks
      const captionsRes = await fetch(
        `${instance}/api/v1/captions/${videoId}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!captionsRes.ok) {
        diagnostics.push(
          `Invidious ${instance}: captions list HTTP ${captionsRes.status}`
        );
        continue;
      }

      const captionsData = await captionsRes.json();
      const tracks = captionsData?.captions || [];

      if (!tracks.length) {
        diagnostics.push(`Invidious ${instance}: no caption tracks`);
        continue;
      }

      // Find English track, or fall back to first available
      const enTrack = tracks.find(
        (t: { language_code?: string; languageCode?: string }) => {
          const code = t.language_code || t.languageCode || "";
          return code === "en" || code.startsWith("en");
        }
      );
      const track = enTrack || tracks[0];
      const captionUrl = track.url;

      if (!captionUrl) {
        diagnostics.push(`Invidious ${instance}: track has no URL`);
        continue;
      }

      // The URL may be relative to the instance or absolute
      const fullUrl = captionUrl.startsWith("http")
        ? captionUrl
        : `${instance}${captionUrl}`;

      const xmlRes = await fetch(fullUrl, {
        signal: AbortSignal.timeout(10000),
      });

      if (!xmlRes.ok) {
        diagnostics.push(
          `Invidious ${instance}: caption fetch HTTP ${xmlRes.status}`
        );
        continue;
      }

      const xml = await xmlRes.text();
      if (!xml.includes("<text") && !xml.includes("<body>")) {
        // Might be JSON format from some instances
        try {
          const jsonData = JSON.parse(xml);
          if (Array.isArray(jsonData)) {
            const text = jsonData
              .map(
                (seg: { text?: string; utf8?: string }) =>
                  seg.text || seg.utf8 || ""
              )
              .filter(Boolean)
              .join(" ");
            if (text.trim()) {
              diagnostics.push(
                `Invidious ${instance}: success (JSON, ${text.length} chars)`
              );
              return text;
            }
          }
        } catch {
          // not JSON either
        }
        diagnostics.push(
          `Invidious ${instance}: response not recognized format`
        );
        continue;
      }

      diagnostics.push(`Invidious ${instance}: success`);
      return parseXmlTranscript(xml);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      diagnostics.push(`Invidious ${instance}: ${msg}`);
      continue;
    }
  }

  return null;
}

// Strategy A: Extract transcript params from ytInitialData on the watch page,
// then call the get_transcript innertube endpoint.
// This bypasses the player response entirely.
async function fetchTranscriptViaWatchPage(
  videoId: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { headers: YT_HEADERS }
    );

    if (!res.ok) {
      diagnostics.push(`WatchPage: HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();
    diagnostics.push(`WatchPage: got ${html.length} chars`);

    // First try to get caption URLs from ytInitialPlayerResponse
    const playerJson = extractJsonObject(
      html,
      "var ytInitialPlayerResponse ="
    );
    if (playerJson) {
      try {
        const player = JSON.parse(playerJson);
        const tracks =
          player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length > 0) {
          const enTrack = tracks.find(
            (t: { languageCode: string }) =>
              t.languageCode === "en" || t.languageCode?.startsWith("en")
          );
          const captionUrl = (enTrack || tracks[0]).baseUrl;
          if (captionUrl) {
            const captionRes = await fetch(captionUrl);
            if (captionRes.ok) {
              diagnostics.push("WatchPage: got captions from player response");
              return parseXmlTranscript(await captionRes.text());
            }
          }
        }
        diagnostics.push(
          `WatchPage: player parsed but no caption tracks`
        );
      } catch {
        diagnostics.push("WatchPage: player JSON parse failed");
      }
    }

    // Extract ytInitialData and find transcript engagement panel
    const dataJson = extractJsonObject(html, "var ytInitialData =");
    if (!dataJson) {
      diagnostics.push("WatchPage: no ytInitialData found");
      return null;
    }

    let initialData;
    try {
      initialData = JSON.parse(dataJson);
    } catch {
      diagnostics.push("WatchPage: ytInitialData parse failed");
      return null;
    }

    // Navigate to engagement panels to find transcript params
    const panels = initialData?.engagementPanels || [];
    let transcriptParams: string | null = null;

    for (const panel of panels) {
      const renderer =
        panel?.engagementPanelSectionListRenderer?.content
          ?.continuationItemRenderer?.continuationEndpoint
          ?.getTranscriptEndpoint?.params;
      if (renderer) {
        transcriptParams = renderer;
        break;
      }
    }

    // Also search in the full serialized JSON as a fallback
    if (!transcriptParams) {
      const jsonStr = JSON.stringify(initialData);
      const paramMatch = jsonStr.match(
        /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/
      );
      if (paramMatch) {
        transcriptParams = paramMatch[1];
      }
    }

    if (!transcriptParams) {
      diagnostics.push("WatchPage: no transcript params in ytInitialData");
      return null;
    }

    diagnostics.push(
      "WatchPage: found transcript params, calling get_transcript"
    );

    // Call the get_transcript innertube endpoint
    const transcriptRes = await fetch(
      "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...YT_HEADERS,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20240313.05.00",
              hl: "en",
              gl: "US",
            },
          },
          params: transcriptParams,
        }),
      }
    );

    if (!transcriptRes.ok) {
      diagnostics.push(
        `WatchPage: get_transcript HTTP ${transcriptRes.status}`
      );
      return null;
    }

    const transcriptData = await transcriptRes.json();

    // Extract text from the transcript response - try multiple known structures
    const segments =
      transcriptData?.actions?.[0]?.updateEngagementPanelAction?.content
        ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
        ?.transcriptSegmentListRenderer?.initialSegments ||
      transcriptData?.actions?.[0]?.updateEngagementPanelAction?.content
        ?.transcriptRenderer?.body?.transcriptBodyRenderer
        ?.transcriptSegmentListRenderer?.initialSegments ||
      [];

    if (segments.length > 0) {
      const text = segments
        .map(
          (seg: {
            transcriptSegmentRenderer?: {
              snippet?: { runs?: Array<{ text?: string }> };
            };
          }) => {
            const runs =
              seg?.transcriptSegmentRenderer?.snippet?.runs || [];
            return runs
              .map((r: { text?: string }) => r.text || "")
              .join("");
          }
        )
        .filter(Boolean)
        .join(" ");

      if (text.trim()) {
        diagnostics.push(
          `WatchPage: get_transcript success (${text.length} chars)`
        );
        return text;
      }
    }

    // Fallback: regex-extract transcript segments from the response JSON string
    const bodyStr = JSON.stringify(transcriptData);
    const snippets: string[] = [];
    const snippetRegex =
      /"transcriptSegmentRenderer"[^}]*"snippet"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = snippetRegex.exec(bodyStr)) !== null) {
      snippets.push(m[1]);
    }
    if (snippets.length > 0) {
      diagnostics.push(
        `WatchPage: get_transcript regex got ${snippets.length} segments`
      );
      return snippets.join(" ");
    }

    diagnostics.push("WatchPage: get_transcript returned no usable segments");
    return null;
  } catch (e) {
    diagnostics.push(
      `WatchPage: error: ${e instanceof Error ? e.message : "unknown"}`
    );
    return null;
  }
}

// Strategy B: Try the timedtext list API directly to discover caption tracks,
// then fetch the captions XML.
async function fetchTranscriptViaTimedText(
  videoId: string
): Promise<string | null> {
  try {
    // First get the list of available caption tracks
    const listRes = await fetch(
      `https://www.youtube.com/api/timedtext?v=${videoId}&type=list`,
      { headers: YT_HEADERS }
    );

    if (!listRes.ok) {
      diagnostics.push(`TimedText: list HTTP ${listRes.status}`);
      return null;
    }

    const listXml = await listRes.text();
    diagnostics.push(`TimedText: list got ${listXml.length} chars`);

    // Parse available tracks from XML
    const trackMatches = [...listXml.matchAll(/lang_code="([^"]+)"/g)];

    if (trackMatches.length === 0) {
      diagnostics.push("TimedText: no tracks found in list");

      // Try fetching English directly anyway
      const directRes = await fetch(
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`,
        { headers: YT_HEADERS }
      );
      if (directRes.ok) {
        const xml = await directRes.text();
        if (xml.includes("<text")) {
          diagnostics.push("TimedText: direct en fetch worked");
          return parseXmlTranscript(xml);
        }
      }

      // Also try auto-generated captions
      const autoRes = await fetch(
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`,
        { headers: YT_HEADERS }
      );
      if (autoRes.ok) {
        const xml = await autoRes.text();
        if (xml.includes("<text")) {
          diagnostics.push("TimedText: auto-generated en fetch worked");
          return parseXmlTranscript(xml);
        }
      }

      diagnostics.push("TimedText: direct fetches also failed");
      return null;
    }

    // Find English track, or use first available
    const langs = trackMatches.map((m) => m[1]);
    diagnostics.push(`TimedText: found langs: ${langs.join(", ")}`);
    const lang =
      langs.find((l) => l === "en" || l.startsWith("en")) || langs[0];

    // Check for name attribute
    const nameMatch = listXml.match(
      new RegExp(`lang_code="${lang}"[^>]*name="([^"]*)"`, "i")
    );
    const name = nameMatch ? nameMatch[1] : "";

    const captionRes = await fetch(
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&name=${encodeURIComponent(name)}&fmt=srv3`,
      { headers: YT_HEADERS }
    );

    if (!captionRes.ok) {
      diagnostics.push(`TimedText: caption fetch HTTP ${captionRes.status}`);
      return null;
    }

    const xml = await captionRes.text();
    if (!xml.includes("<text")) {
      diagnostics.push("TimedText: caption response has no <text> elements");
      return null;
    }

    diagnostics.push("TimedText: success");
    return parseXmlTranscript(xml);
  } catch (e) {
    diagnostics.push(
      `TimedText: error: ${e instanceof Error ? e.message : "unknown"}`
    );
    return null;
  }
}

// Strategy C: Use innertube player API to get caption URLs
async function fetchTranscriptViaInnertube(
  videoId: string
): Promise<string | null> {
  const clients = [
    {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
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
            ...YT_HEADERS,
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: { ...clientConfig, hl: "en", gl: "US" },
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

      const data = await res.json();
      const tracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (!tracks || tracks.length === 0) {
        diagnostics.push(
          `Innertube ${clientConfig.clientName}: no caption tracks`
        );
        continue;
      }

      const enTrack = tracks.find(
        (t: { languageCode: string }) =>
          t.languageCode === "en" || t.languageCode?.startsWith("en")
      );
      const captionUrl = (enTrack || tracks[0]).baseUrl;
      if (!captionUrl) continue;

      const captionRes = await fetch(captionUrl);
      if (!captionRes.ok) continue;

      diagnostics.push(
        `Innertube ${clientConfig.clientName}: got captions`
      );
      return parseXmlTranscript(await captionRes.text());
    } catch (e) {
      diagnostics.push(
        `Innertube ${clientConfig.clientName}: ${e instanceof Error ? e.message : "unknown"}`
      );
    }
  }

  return null;
}

async function fetchTranscript(videoId: string): Promise<string> {
  diagnostics.length = 0;

  // Strategy 0 (Primary): Invidious API - most reliable from datacenter IPs
  const fromInvidious = await fetchTranscriptViaInvidious(videoId);
  if (fromInvidious) return fromInvidious;

  // Strategy A: Watch page -> ytInitialData -> get_transcript endpoint
  const fromWatchPage = await fetchTranscriptViaWatchPage(videoId);
  if (fromWatchPage) return fromWatchPage;

  // Strategy B: Direct timedtext API
  const fromTimedText = await fetchTranscriptViaTimedText(videoId);
  if (fromTimedText) return fromTimedText;

  // Strategy C: Innertube player API (least likely to work from datacenter IPs)
  const fromInnertube = await fetchTranscriptViaInnertube(videoId);
  if (fromInnertube) return fromInnertube;

  throw new Error(
    "Could not retrieve transcript. Debug: " + diagnostics.join(" | ")
  );
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
