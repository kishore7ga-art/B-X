import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { AuthError } from "@/auth-service";

export const generateSectionSchema = z.object({
  prompt: z
    .string({ error: "Enter a valid prompt" })
    .trim()
    .min(3, "Prompt must be at least 3 characters")
    .max(500, "Prompt is too long"),
  sectionType: z.string().trim().optional(),
  subdomain: z.string().trim().optional(),
});

function sanitizeGeneratedHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "section",
      "header",
      "footer",
      "nav",
      "main",
      "aside",
      "article",
      "button",
      "input",
      "select",
      "form",
      "svg",
      "path",
    ]),
    allowedAttributes: {
      "*": ["style", "class", "id", "href", "target", "type", "placeholder", "aria-*", "viewBox", "fill", "xmlns", "d"],
    },
  });
}

export async function generateAiSection(input: unknown) {
  const parsed = generateSectionSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid prompt";
    throw new AuthError(msg, 400);
  }

  const { prompt, sectionType, subdomain } = parsed.data;
  const promptLower = prompt.toLowerCase();

  let type = sectionType || "hero";
  if (promptLower.includes("research") || promptLower.includes("lab")) type = "research";
  else if (promptLower.includes("facility") || promptLower.includes("lab") || promptLower.includes("sports")) type = "facilities";
  else if (promptLower.includes("course") || promptLower.includes("program") || promptLower.includes("degree")) type = "courses";
  else if (promptLower.includes("placement") || promptLower.includes("salary") || promptLower.includes("job")) type = "placements";
  else if (promptLower.includes("contact") || promptLower.includes("form") || promptLower.includes("enquiry")) type = "contact";
  else if (promptLower.includes("faq") || promptLower.includes("question")) type = "faq";
  else if (promptLower.includes("event") || promptLower.includes("fest") || promptLower.includes("seminar")) type = "events";

  const titleFromPrompt = prompt.slice(0, 40).replace(/[^\w\s]/gi, "");
  const sectionTitle = titleFromPrompt.charAt(0).toUpperCase() + titleFromPrompt.slice(1) || "AI Generated Section";
  const sectionId = `ai-sec-${Date.now()}`;

  let rawHtml = "";

  if (type === "research") {
    rawHtml = `<section style="background: #0d1527; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1000px; margin: 0 auto; text-align: center;">
    <span style="color: #38bdf8; font-size: 12px; font-weight: 900; text-transform: uppercase;">AI GENERATED RESEARCH & INNOVATION</span>
    <h2 style="font-size: 36px; font-weight: 900; margin-top: 10px;">${sectionTitle}</h2>
    <p style="font-size: 15px; color: #94a3b8; margin-top: 14px; max-width: 700px; margin-left: auto; margin-right: auto;">Advanced R&D laboratories accelerating breakthroughs in AI, Quantum Computing, and Advanced Robotics.</p>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 36px; text-align: left;">
      <div style="background: #1e293b; padding: 24px; border-radius: 16px; border: 1px solid #334155;"><h4 style="font-size: 18px; font-weight: 900; color: #38bdf8; margin: 0;">AI & Vision Lab</h4><p style="font-size: 13px; color: #94a3b8; margin-top: 8px;">Neural architecture research and autonomous navigation models.</p></div>
      <div style="background: #1e293b; padding: 24px; border-radius: 16px; border: 1px solid #334155;"><h4 style="font-size: 18px; font-weight: 900; color: #38bdf8; margin: 0;">BioTech Innovations</h4><p style="font-size: 13px; color: #94a3b8; margin-top: 8px;">Genome sequencing, computational biology, and drug discovery.</p></div>
      <div style="background: #1e293b; padding: 24px; border-radius: 16px; border: 1px solid #334155;"><h4 style="font-size: 18px; font-weight: 900; color: #38bdf8; margin: 0;">Clean Energy Research</h4><p style="font-size: 13px; color: #94a3b8; margin-top: 8px;">Solar photovoltaic efficiency and battery storage systems.</p></div>
    </div>
  </div>
</section>`;
  } else if (type === "faq") {
    rawHtml = `<section style="background: #f8fafc; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 900px; margin: 0 auto;">
    <div style="text-align: center;">
      <span style="color: #2563eb; font-size: 12px; font-weight: 900; text-transform: uppercase;">FREQUENTLY ASKED QUESTIONS</span>
      <h2 style="font-size: 36px; font-weight: 900; margin-top: 10px;">${sectionTitle}</h2>
    </div>
    <div style="display: flex; flex-direction: column; gap: 16px; margin-top: 36px;">
      <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h4 style="font-size: 16px; font-weight: 900; margin: 0; color: #0f172a;">How do I apply for admissions?</h4><p style="font-size: 14px; color: #64748b; margin-top: 8px; line-height: 1.6;">Fill out the online access request or application form on our website to begin your application process.</p></div>
      <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h4 style="font-size: 16px; font-weight: 900; margin: 0; color: #0f172a;">Are merit scholarships available?</h4><p style="font-size: 14px; color: #64748b; margin-top: 8px; line-height: 1.6;">Yes, we offer up to 100% tuition fee scholarships for top-ranking academic applicants.</p></div>
    </div>
  </div>
</section>`;
  } else {
    rawHtml = `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid #e2e8f0;">
  <div style="max-width: 1000px; margin: 0 auto; text-align: center;">
    <span style="background: #dbeafe; color: #1d4ed8; padding: 6px 18px; border-radius: 9999px; font-size: 12px; font-weight: 900; text-transform: uppercase;">AI GENERATED SECTION</span>
    <h2 style="font-size: 40px; font-weight: 900; margin-top: 18px; color: #0f172a;">${sectionTitle}</h2>
    <p style="font-size: 16px; color: #475569; margin-top: 14px; line-height: 1.7; max-width: 760px; margin-left: auto; margin-right: auto;">${prompt}</p>
    <div style="margin-top: 32px; display: flex; justify-content: center; gap: 16px;">
      <a href="#explore" style="background: #2563eb; color: #ffffff; padding: 12px 28px; border-radius: 10px; font-size: 14px; font-weight: 800; text-decoration: none;">Explore Details</a>
      <a href="#contact" style="background: #f1f5f9; color: #0f172a; border: 1px solid #cbd5e1; padding: 12px 28px; border-radius: 10px; font-size: 14px; font-weight: 800; text-decoration: none;">Contact Us</a>
    </div>
  </div>
</section>`;
  }

  const cleanCode = sanitizeGeneratedHtml(rawHtml);

  return {
    section: {
      id: sectionId,
      title: sectionTitle,
      sectionType: type,
      code: cleanCode,
      sortOrder: 99,
      subdomain: subdomain || "greenfield",
    },
  };
}
