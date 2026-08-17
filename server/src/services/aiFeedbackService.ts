import { AIFeedback, LearningProfile } from "../models";
import type { ISkillMastery } from "../models/LearningProfile";
import type { AiAnalysisResult, AiErrorAnnotation, AIFeedbackType } from "@testora-platform/shared";
import { ApiError } from "../utils/helpers";

export type FeedbackType = AIFeedbackType;
export type AiFeedback = AiAnalysisResult;
const ANNOTATION_SEVERITIES = new Set(["low", "medium", "high"]);

const MODEL = process.env.AI_MODEL || "qwen-plus";
const BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const API_URL = `${BASE_URL}/responses`;
// Qwen-family MaaS gateways (Aliyun/DashScope) default to "thinking" mode,
// which burns most of the latency budget on hidden reasoning tokens. Disable
// it unless the operator explicitly opts in via AI_ENABLE_THINKING=true.
const DISABLE_THINKING = /maas|aliyuncs|dashscope|qwen/i.test(BASE_URL) && process.env.AI_ENABLE_THINKING !== "true";
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const clampTrend = (value: number) => Math.max(-100, Math.min(100, Math.round(value)));

function extractOutputText(payload: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }): string {
  return (payload.output || []).filter((item) => item.type === "message").flatMap((item) => item.content || []).filter((part) => part.type === "output_text" && part.text).map((part) => part.text as string).join("\n").trim();
}
export function parseJson(text: string, submissionLength: number): AiFeedback {
  try {
    const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim()) as AiFeedback;
    if (typeof parsed.overallScore !== "number" || !parsed.skillScores || !Array.isArray(parsed.strengths) || !Array.isArray(parsed.improvements)) throw new Error();
    parsed.overallScore = clamp(parsed.overallScore);
    parsed.skillScores = Object.fromEntries(Object.entries(parsed.skillScores).map(([key, value]) => [key, clamp(Number(value))]).filter(([, value]) => Number.isFinite(value)));
    parsed.bands = parsed.bands && typeof parsed.bands === "object" ? { ielts: typeof parsed.bands.ielts === "number" ? clamp(Math.max(0, Math.min(9, parsed.bands.ielts))) : null, pte: typeof parsed.bands.pte === "number" ? clamp(Math.max(0, Math.min(90, parsed.bands.pte))) : null } : null;
    parsed.annotations = Array.isArray(parsed.annotations) ? parsed.annotations.filter((a: AiErrorAnnotation) => a && typeof a === "object" && typeof a.start === "number" && typeof a.end === "number" && typeof a.original === "string" && typeof a.correction === "string").map((a: AiErrorAnnotation) => ({ ...a, start: Math.max(0, Math.min(submissionLength, Math.trunc(a.start))), end: Math.max(0, Math.min(submissionLength, Math.trunc(a.end))), severity: ANNOTATION_SEVERITIES.has(a.severity) ? a.severity : "medium" })).slice(0, 50) : [];
    parsed.modelAnswer = typeof parsed.modelAnswer === "string" && parsed.modelAnswer.trim() ? parsed.modelAnswer.trim().slice(0, 5000) : null;
    parsed.advice = typeof parsed.advice === "string" && parsed.advice.trim() ? parsed.advice.trim().slice(0, 2000) : null;
    return parsed;
  } catch { throw new ApiError(502, "AI feedback returned an invalid response"); }
}

async function updateLearningProfile(studentId: string, skillScores: Record<string, number>) {
  const profile = await LearningProfile.findOneAndUpdate({ studentId }, { $setOnInsert: { studentId } }, { upsert: true, new: true });
  const skills = profile.skills as unknown as Map<string, ISkillMastery>;
  for (const [skill, rawScore] of Object.entries(skillScores)) {
    const score = clamp(rawScore);
    const previous = skills.get(skill) || { score: 50, attempts: 0, trend: 0, lastPracticedAt: null };
    const nextScore = previous.attempts === 0 ? score : clamp(previous.score * 0.7 + score * 0.3);
    skills.set(skill, { score: nextScore, attempts: previous.attempts + 1, trend: clampTrend(nextScore - previous.score), lastPracticedAt: new Date() });
  }
  profile.skills = skills;
  profile.totalPracticeSessions += 1;
  profile.lastPracticeAt = new Date();
  await profile.save();
}

export async function evaluateLanguage(type: FeedbackType, text: string, prompt?: string): Promise<AiFeedback> {
  if (!process.env.AI_API_KEY) throw new ApiError(503, "AI feedback is not configured");
  const normalized = text.trim();
  if (normalized.length < 20) throw new ApiError(400, "Response is too short for meaningful feedback");
  if (normalized.length > 12000) throw new ApiError(400, "Response exceeds the 12,000 character limit");
  const rubric = type === "WRITING" ? "Evaluate grammar, vocabulary, coherence/cohesion, task response, and organization." : "Evaluate grammar, vocabulary, coherence, fluency, task response (how fully the response addresses the task prompt, staying on topic), and speaking delivery from the supplied transcript. Do not claim to assess pronunciation from text alone. Score task response into skillScores.taskResponse (0-100); if no task prompt is provided, set skillScores.taskResponse to null.";
  const input = `You are an English-learning assessment assistant. ${rubric}\nReturn ONLY valid JSON with this exact shape: {"overallScore":0,"skillScores":{"grammar":0,"vocabulary":0,"coherence":0,"fluency":0,"taskResponse":0},"strengths":[],"improvements":[],"grammar":[],"vocabulary":[],"coherence":[],"fluency":[],"pronunciation":[],"nextSteps":[],"disclaimer":"","bands":{"ielts":null,"pte":null},"annotations":[{"start":0,"end":0,"original":"","correction":"","better":"","category":"","note":"","severity":"low"}],"modelAnswer":null,"advice":null}. skillScores values and overallScore must be 0-100. bands.ielts is 0-9, bands.pte is 0-90; set to null unless confident (formative estimate only, never an official score). annotations are inline corrections: character offsets start/end relative to the student response, original is the text being corrected, correction is the fix, better is an optional stronger alternative, category is one of grammar/vocabulary/coherence/fluency/task_response/spelling/punctuation, severity is low/medium/high. modelAnswer is an optional concise model response of at most 80 words; advice is concise personalized study advice of at most 50 words. Keep each array to at most 4 concise items (annotations up to 10). Do not invent facts. This is formative feedback, not an official IELTS/PTE score.\n${prompt ? `Task prompt: ${prompt}\n` : ""}Student ${type.toLowerCase()} response:\n${normalized}`;
  let response: Response;
  try {
    response = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_API_KEY}` }, body: JSON.stringify(DISABLE_THINKING ? { model: MODEL, input, enable_thinking: false } : { model: MODEL, input }), signal: AbortSignal.timeout(120000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new ApiError(504, "AI feedback is taking too long right now. Please try again in a moment.");
    console.error("AI feedback request failed", error instanceof Error ? error.message : error);
    throw new ApiError(502, "AI feedback service is temporarily unavailable");
  }
  if (!response.ok) { console.error("AI feedback request failed", response.status); throw new ApiError(502, "AI feedback service is temporarily unavailable"); }
  const output = extractOutputText(await response.json() as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> });
  if (!output) throw new ApiError(502, "AI feedback returned no result");
  const feedback = parseJson(output, normalized.length); feedback.disclaimer ||= "AI-generated formative feedback; not an official IELTS/PTE score."; return feedback;
}

export async function createAIFeedback(studentId: string, type: FeedbackType, text: string, prompt?: string, context?: { attemptId?: string | null; examId?: string | null }): Promise<AiFeedback & { id: string; createdAt: Date }> {
  const feedback = await evaluateLanguage(type, text, prompt);
  const saved = await AIFeedback.create({ studentId, type, prompt: prompt || null, submission: text.trim(), ...feedback, providerModel: MODEL, attemptId: context?.attemptId || null, examId: context?.examId || null });
  await updateLearningProfile(studentId, feedback.skillScores);
  return { ...feedback, id: String(saved._id), createdAt: saved.createdAt };
}

export async function listAIFeedback(studentId: string, limit = 20) {
  const docs = await AIFeedback.find({ studentId }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 50)).select("type prompt submission overallScore skillScores bands annotations modelAnswer advice strengths improvements grammar vocabulary coherence fluency pronunciation nextSteps disclaimer providerModel createdAt").lean();
  return docs.map((doc) => ({ ...doc, id: String(doc._id) }));
}
