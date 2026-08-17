import { ApiError } from "../utils/helpers";

export type FeedbackType = "WRITING" | "SPEAKING";

export interface AiFeedback {
  overallScore: number;
  strengths: string[];
  improvements: string[];
  grammar: string[];
  vocabulary: string[];
  coherence: string[];
  fluency: string[];
  pronunciation: string[];
  nextSteps: string[];
  disclaimer: string;
  provider: string;
  model: string;
}

interface AiProvider {
  name: string;
  model: string;
  evaluate(input: string): Promise<string>;
}

function getProvider(): AiProvider {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new ApiError(503, "AI feedback is not configured");

  const baseUrl = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.AI_MODEL || "gpt-5.6";
  const provider = baseUrl.includes("dashscope") || baseUrl.includes("maas.aliyuncs.com") ? "dashscope" : "openai-compatible";

  return {
    name: provider,
    model,
    async evaluate(input: string): Promise<string> {
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error("AI feedback request failed", response.status, detail.slice(0, 500));
        throw new ApiError(502, "AI feedback service is temporarily unavailable");
      }

      const payload = await response.json() as {
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      return (payload.output || [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text" && part.text)
        .map((part) => part.text as string)
        .join("\n")
        .trim();
    },
  };
}

function parseJson(text: string): Omit<AiFeedback, "provider" | "model"> {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<AiFeedback>;
    if (typeof parsed.overallScore !== "number" || !Array.isArray(parsed.strengths) || !Array.isArray(parsed.improvements)) {
      throw new Error("Invalid feedback shape");
    }
    return {
      overallScore: Math.max(0, Math.min(100, parsed.overallScore)),
      strengths: parsed.strengths.slice(0, 4),
      improvements: parsed.improvements.slice(0, 4),
      grammar: (parsed.grammar || []).slice(0, 4),
      vocabulary: (parsed.vocabulary || []).slice(0, 4),
      coherence: (parsed.coherence || []).slice(0, 4),
      fluency: (parsed.fluency || []).slice(0, 4),
      pronunciation: (parsed.pronunciation || []).slice(0, 4),
      nextSteps: (parsed.nextSteps || []).slice(0, 4),
      disclaimer: parsed.disclaimer || "AI-generated formative feedback; not an official IELTS/PTE score.",
    };
  } catch {
    throw new ApiError(502, "AI feedback returned an invalid response");
  }
}

export async function evaluateLanguage(type: FeedbackType, text: string, prompt?: string): Promise<AiFeedback> {
  const normalized = text.trim();
  if (normalized.length < 20) throw new ApiError(400, "Response is too short for meaningful feedback");
  if (normalized.length > 12000) throw new ApiError(400, "Response exceeds the 12,000 character limit");

  const provider = getProvider();
  const rubric = type === "WRITING"
    ? "Evaluate grammar, vocabulary, coherence/cohesion, task response, and organization."
    : "Evaluate grammar, vocabulary, coherence, fluency, and speaking delivery from the supplied transcript. Do not claim to assess pronunciation from text alone.";
  const input = `You are an English-learning assessment assistant. ${rubric}\nReturn ONLY valid JSON with this exact shape: {"overallScore":0,"strengths":[],"improvements":[],"grammar":[],"vocabulary":[],"coherence":[],"fluency":[],"pronunciation":[],"nextSteps":[],"disclaimer":""}. overallScore must be 0-100. Keep each array to at most 4 concise items. Do not invent facts. This is formative feedback, not an official IELTS/PTE score.\n${prompt ? `Task prompt: ${prompt}\n` : ""}Student ${type.toLowerCase()} response:\n${normalized}`;
  const output = await provider.evaluate(input);
  if (!output) throw new ApiError(502, "AI feedback returned no result");
  return { ...parseJson(output), provider: provider.name, model: provider.model };
}
