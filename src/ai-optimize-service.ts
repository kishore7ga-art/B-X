/**
 * AI Section Optimize Service
 *
 * Calls the Gemini API to fix and optimize an existing Xite section
 * for responsive behavior, preserving the original content and design.
 *
 * The GEMINI_API_KEY is read exclusively from server-side environment
 * variables and is NEVER returned to the browser in any response.
 */

import { z } from "zod";
import { AuthError } from "@/auth-service";

export const optimizeSectionSchema = z.object({
  code: z
    .string({ error: "Section code is required" })
    .trim()
    .min(10, "Section code is too short — paste the full HTML")
    .max(120000, "Section code is too large"),
});

/** Strip markdown code fences that Gemini sometimes wraps around the output. */
function cleanGeminiResponse(raw: string): string {
  // Remove ```html ... ``` or ``` ... ``` wrappers
  let cleaned = raw.trim();

  // Remove leading ```html or ```
  cleaned = cleaned.replace(/^```[a-z]*\s*/i, "");
  // Remove trailing ```
  cleaned = cleaned.replace(/\s*```\s*$/i, "");

  // Remove any extra prose before the first <style> or first HTML tag
  // Only do this if there's actual HTML content in the response
  const firstTagIdx = cleaned.search(/<style[\s>]|<section[\s>]|<header[\s>]|<div[\s>]|<nav[\s>]|<footer[\s>]|<article[\s>]|<main[\s>]/i);
  if (firstTagIdx > 0) {
    // Check if what precedes looks like prose (no HTML tags in it)
    const leadingText = cleaned.slice(0, firstTagIdx);
    if (!/<[a-z]/i.test(leadingText)) {
      cleaned = cleaned.slice(firstTagIdx);
    }
  }

  return cleaned.trim();
}

const GEMINI_SYSTEM_PROMPT = `You are an expert HTML/CSS/JavaScript developer working specifically for the Xite College SaaS website platform.

Your task is to fix and optimize an existing website section for responsive behavior while preserving its original content, design intent, structure, classes, IDs, and functionality.

XITE SECTION RULES:
1. Return ONLY the final code.
2. No explanation.
3. No Markdown code fences.
4. The first element must be: <style>
5. ALL CSS must be inside the <style> block.
6. After </style>, return HTML body content only.
7. NEVER return: <!DOCTYPE html>, <html>, <head>, <body>
8. Do not create a complete HTML document.
9. Do not use external CSS libraries.
10. Do not use Bootstrap.
11. Do not use Tailwind.
12. Do not use React inside the generated section.
13. Use HTML + CSS + vanilla JavaScript only.
14. Preserve existing classes and IDs whenever possible.
15. Preserve existing content.
16. Do not unnecessarily rewrite the entire section.
17. Fix the existing code instead of replacing it with an unrelated design.

XITE EDITOR COMPATIBILITY:
- Root section must use width: 100%.
- Use box-sizing: border-box.
- Prevent horizontal overflow.
- Do not modify the global body styling.
- Do not use position: fixed.
- Do not use position: sticky.
- Avoid excessive absolute positioning.
- Do not use z-index values above 100.
- Do not add margin-top to the first child of the section.
- Do not rely on external assets that may break.
- Keep the section safe to inject into an existing DOM.
- CSS selectors should be scoped to the section to prevent conflicts with other Xite sections.

RESPONSIVE REQUIREMENTS:

DESKTOP (1200px and above):
- Preserve the full desktop layout.
- Navigation/content should fit naturally.
- No horizontal overflow.

TABLET (768px):
- Reduce unnecessary padding.
- Adjust typography where necessary.
- Maintain correct alignment.
- Prevent overlapping elements.
- Allow navigation/content to wrap or adapt naturally.

MOBILE (375px):
- Hide desktop navigation when appropriate.
- Show a hamburger menu when the section contains navigation.
- Hamburger must use vanilla JavaScript.
- Mobile menu must be usable with touch.
- Text must wrap correctly.
- Buttons must fit the viewport.
- Images must scale responsively.
- No horizontal scrolling.
- No clipped content.
- No overlapping elements.

RESPONSIVE CSS:
Use appropriate media queries such as:
@media (max-width: 768px) { ... }
@media (max-width: 480px) { ... }
Do not blindly apply the same breakpoint to every section. Choose sensible responsive behavior based on the actual section.

DESIGN PRESERVATION:
Do not change:
- College name
- Existing text
- Existing links
- Existing images
- Existing colors unless required to fix readability
- Existing visual identity
- Existing section purpose

Only make changes necessary for:
- responsiveness
- broken CSS
- overflow
- alignment
- spacing
- typography scaling
- mobile navigation
- layout stability

AI QUALITY CHECK:
Before returning the code, internally verify:
- Desktop 1440px
- Desktop 1200px
- Tablet 768px
- Mobile 430px
- Mobile 375px

Check:
- No horizontal overflow
- No overlapping elements
- No clipped text
- No broken navigation
- No broken buttons
- No broken images
- No unexpected white gaps
- No CSS leaking into other Xite sections
- HTML remains valid
- JavaScript is complete

If the existing code is already responsive, make only the necessary improvements.`;

/** Timeout for Gemini API calls — 60 seconds for complex sections. */
const GEMINI_TIMEOUT_MS = 60_000;

export async function optimizeSection(input: unknown): Promise<{ code: string }> {
  const parsed = optimizeSectionSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid request body";
    throw new AuthError(msg, 400);
  }

  const { code } = parsed.data;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Do not expose key existence details — fail with a generic message
    throw new AuthError("AI optimization is not configured on this deployment", 503);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  // gemini-1.5-flash is universally available with all Google AI Studio keys.
  // gemini-2.0-flash is newer but requires specific project enablement.
  const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: GEMINI_SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Fix and optimize the following Xite section code for responsiveness. Return ONLY the corrected embeddable section code — no explanations, no markdown fences:\n\n${code}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 16384,
          candidateCount: 1,
        },
      }),
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new AuthError("AI request timed out. Please try again.", 504);
    }
    // Do not expose internal details
    throw new AuthError("Failed to connect to AI service. Please try again.", 502);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // Parse error body carefully — never forward the raw Gemini response as-is
    // because it may contain quota/key information
    const status = response.status;
    if (status === 400) throw new AuthError("AI service rejected the request — the section code may be malformed.", 400);
    if (status === 403 || status === 401) throw new AuthError("AI service configuration error. Contact the platform administrator.", 502);
    if (status === 429) throw new AuthError("AI service is temporarily busy. Please wait a moment and try again.", 429);
    if (status >= 500) throw new AuthError("AI service is temporarily unavailable. Please try again later.", 502);
    throw new AuthError(`AI service returned an unexpected error (${status}). Please try again.`, 502);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new AuthError("AI service returned an unreadable response. Please try again.", 502);
  }

  // Navigate the Gemini response structure safely
  const rawText: string | undefined =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText || !rawText.trim()) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new AuthError("The AI declined to process this content due to safety filters.", 422);
    }
    if (finishReason === "MAX_TOKENS") {
      throw new AuthError("The section code is too large for AI processing. Try a smaller section.", 413);
    }
    throw new AuthError("The AI returned an empty response. Please try again.", 502);
  }

  const optimizedCode = cleanGeminiResponse(rawText);

  if (!optimizedCode || optimizedCode.length < 10) {
    throw new AuthError("The AI response did not contain valid HTML. Please try again.", 502);
  }

  return { code: optimizedCode };
}
