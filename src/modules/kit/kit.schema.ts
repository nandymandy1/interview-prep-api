import { z } from 'zod';

// Canonical Appendix A contract is exact: unknown keys (including editor/lifecycle
// metadata such as pinned flags or KitIdSequences) are rejected, never silently stripped.
const requirementSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  kind: z.enum(['technical', 'behavioural', 'domain']),
  priority: z.enum(['must', 'nice']),
}).strict();

const questionSchema = z.object({
  id: z.string().trim().min(1),
  requirement_ids: z.array(z.string().trim().min(1)),
  category: z.enum(['technical', 'behavioural', 'system-design', 'company-fit']),
  prompt: z.string().trim().min(1),
  answer_outline: z.string().trim().min(1),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
}).strict();

const flashcardSchema = z.object({
  id: z.string().trim().min(1),
  front: z.string().trim().min(1),
  back: z.string().trim().min(1),
  requirement_ids: z.array(z.string().trim().min(1)),
}).strict();

export const interviewKitSchema = z.object({
  source: z.object({ company: z.string().trim().min(1), company_url: z.string().trim().min(1), role: z.string().trim().min(1), location: z.string().trim().min(1), jd_chars: z.number().int().nonnegative(), researched_at: z.string().trim().min(1), pages_used: z.array(z.string().trim().min(1)) }).strict(),
  company_brief: z.object({ summary: z.string().trim().min(1), what_they_do: z.string().trim().min(1), sources: z.array(z.string().trim().min(1)) }).strict(),
  role: z.object({ title: z.string().trim().min(1), seniority: z.string().trim().min(1), responsibilities: z.array(z.string().trim().min(1)), requirements: z.array(requirementSchema) }).strict(),
  questions: z.array(questionSchema),
  flashcards: z.array(flashcardSchema),
  schedule: z.object({ days_available: z.number().int().positive(), days: z.array(z.object({ day: z.number().int().positive(), focus: z.string().trim().min(1), question_ids: z.array(z.string().trim().min(1)), minutes: z.number().int().nonnegative() }).strict()) }).strict(),
  coverage: z.object({ uncovered_requirement_ids: z.array(z.string().trim().min(1)), passes: z.number().int().nonnegative() }).strict(),
}).strict();
