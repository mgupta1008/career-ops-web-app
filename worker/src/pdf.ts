/**
 * pdf.ts — CV PDF generation via Playwright (ported from generate-pdf.mjs)
 *
 * Takes parsed CV data and profile, renders to HTML, then converts to PDF
 * using headless Chromium (pre-installed in the worker Docker image).
 */

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const outputDir = process.env.PDF_OUTPUT_DIR || "/app/output";

/**
 * Normalize text for ATS compatibility — ported from generate-pdf.mjs.
 * Converts em-dashes, smart quotes, zero-width chars to ASCII equivalents.
 * Only touches body text, preserves CSS, JS, and tag attributes.
 */
function normalizeTextForATS(html: string): string {
  const masks: string[] = [];
  const masked = html.replace(
    /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      const token = `\u0000MASK${masks.length}\u0000`;
      masks.push(match);
      return token;
    },
  );

  let out = "";
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf("<", i);
    if (lt === -1) {
      out += sanitizeText(masked.slice(i));
      break;
    }
    out += sanitizeText(masked.slice(i, lt));
    const gt = masked.indexOf(">", lt);
    if (gt === -1) {
      out += masked.slice(lt);
      break;
    }
    out += masked.slice(lt, gt + 1);
    i = gt + 1;
  }

  return out.replace(/\u0000MASK(\d+)\u0000/g, (_, n) => masks[Number(n)]);
}

function sanitizeText(text: string): string {
  if (!text) return text;
  let t = text;
  t = t.replace(/\u2014/g, "-"); // em-dash
  t = t.replace(/\u2013/g, "-"); // en-dash
  t = t.replace(/[\u201C\u201D\u201E\u201F]/g, '"'); // smart double quotes
  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'"); // smart single quotes
  t = t.replace(/\u2026/g, "..."); // ellipsis
  t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, ""); // zero-width chars
  t = t.replace(/\u00A0/g, " "); // non-breaking space
  return t;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build CV HTML from profile and parsed CV markdown.
 * Uses Google Fonts CDN (no local font files needed in Docker container).
 * Design mirrors cv-template.html: Space Grotesk headings, DM Sans body.
 */
function buildCvHtml(cvRaw: string, profile: any): string {
  const name = profile?.candidate?.full_name || "Candidate";
  const email = profile?.candidate?.email || "";
  const phone = profile?.candidate?.phone || "";
  const location = profile?.candidate?.location || "";
  const linkedin = profile?.candidate?.linkedin || "";
  const github = profile?.candidate?.github || "";
  const portfolioUrl = profile?.candidate?.portfolio_url || "";
  const targetRoles = Array.isArray(profile?.target_roles?.primary)
    ? profile.target_roles.primary.join(" · ")
    : "";

  // Parse CV sections from raw markdown
  const sections = parseCvSections(cvRaw);

  const contactParts: string[] = [];
  if (email) contactParts.push(`<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`);
  if (phone) contactParts.push(escapeHtml(phone));
  if (location) contactParts.push(escapeHtml(location));
  if (linkedin) contactParts.push(`<a href="https://${escapeHtml(linkedin)}">${escapeHtml(linkedin)}</a>`);
  if (github) contactParts.push(`<a href="${escapeHtml(github)}">${escapeHtml(github)}</a>`);
  if (portfolioUrl) contactParts.push(`<a href="${escapeHtml(portfolioUrl)}">${escapeHtml(portfolioUrl)}</a>`);

  const contactHtml = contactParts.join('<span class="sep"> · </span>');

  const experienceHtml = sections.experience
    .map(
      (exp) => `
    <div class="job">
      <div class="job-header">
        <span class="job-company">${escapeHtml(exp.company)}</span>
      </div>
      <div class="job-role">${escapeHtml(exp.role)}</div>
      <ul>
        ${exp.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n        ")}
      </ul>
    </div>`,
    )
    .join("\n");

  const skillsHtml = sections.skills
    .map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`)
    .join("\n      ");

  const summarySection =
    sections.summary
      ? `<div class="section">
      <div class="section-title">Professional Summary</div>
      <div class="summary-text">${escapeHtml(sections.summary)}</div>
    </div>`
      : "";

  const experienceSection =
    sections.experience.length > 0
      ? `<div class="section">
      <div class="section-title">Work Experience</div>
      ${experienceHtml}
    </div>`
      : "";

  const skillsSection =
    sections.skills.length > 0
      ? `<div class="section">
      <div class="section-title">Skills</div>
      <div class="skills-grid">
        ${skillsHtml}
      </div>
    </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(name)} — CV</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=DM+Sans:wght@100..1000&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'DM Sans', sans-serif;
    font-size: 11px;
    line-height: 1.5;
    color: #1a1a2e;
    background: #ffffff;
    padding: 0;
    margin: 0;
  }
  .page { width: 100%; max-width: 210mm; margin: 0 auto; padding: 2px 0; }
  a { color: #555; text-decoration: none; white-space: nowrap; }

  /* Header */
  .header { margin-bottom: 20px; }
  .header h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: #1a1a2e;
    letter-spacing: -0.02em;
    margin-bottom: 4px;
    line-height: 1.1;
  }
  .header-tagline {
    font-size: 12px;
    color: #555;
    margin-bottom: 6px;
  }
  .header-gradient {
    height: 2px;
    background: linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%));
    border-radius: 1px;
    margin-bottom: 10px;
  }
  .contact-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 0;
    font-size: 10.5px;
    color: #555;
  }
  .sep { color: #ccc; margin: 0 6px; }

  /* Sections */
  .section { margin-bottom: 18px; }
  .section-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: hsl(187,74%,32%);
    border-bottom: 1.5px solid #e2e2e2;
    padding-bottom: 4px;
    margin-bottom: 10px;
  }

  /* Summary */
  .summary-text { font-size: 11px; line-height: 1.7; color: #2f2f2f; }

  /* Experience */
  .job { margin-bottom: 14px; }
  .job-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px; }
  .job-company {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 12.5px;
    font-weight: 600;
    color: hsl(270,70%,45%);
  }
  .job-role { font-size: 11px; font-weight: 600; color: #333; margin-bottom: 6px; }
  .job ul { padding-left: 18px; margin-top: 4px; }
  .job li { font-size: 10.5px; line-height: 1.6; color: #333; margin-bottom: 3px; }

  /* Skills */
  .skills-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .skill-tag {
    font-size: 10px;
    font-weight: 500;
    color: hsl(187,74%,28%);
    background: hsl(187,40%,95%);
    padding: 4px 10px;
    border-radius: 3px;
    border: 1px solid hsl(187,40%,88%);
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>${escapeHtml(name)}</h1>
    ${targetRoles ? `<div class="header-tagline">${escapeHtml(targetRoles)}</div>` : ""}
    <div class="header-gradient"></div>
    <div class="contact-row">${contactHtml}</div>
  </div>

  ${summarySection}
  ${experienceSection}
  ${skillsSection}
</div>
</body>
</html>`;
}

interface CvSection {
  summary: string;
  experience: Array<{ company: string; role: string; bullets: string[] }>;
  skills: string[];
}

function parseCvSections(raw: string): CvSection {
  const lines = raw.split(/\r?\n/);
  let currentSection = "summary";
  let currentExp: { company: string; role: string; bullets: string[] } | null =
    null;
  const experience: CvSection["experience"] = [];
  const skills: string[] = [];
  const summaryLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("# ")) continue; // skip title, it comes from profile

    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim().toLowerCase();
      currentExp = null;
      continue;
    }

    if (currentSection === "summary") {
      summaryLines.push(line);
      continue;
    }

    if (currentSection === "experience") {
      if (line.startsWith("### ")) {
        const text = line.slice(4).trim();
        const sepIndex = text.indexOf("—");
        const company =
          sepIndex > -1 ? text.slice(0, sepIndex).trim() : text;
        const role =
          sepIndex > -1 ? text.slice(sepIndex + 1).trim() : "";
        currentExp = { company, role, bullets: [] };
        experience.push(currentExp);
        continue;
      }
      if (line.startsWith("- ") && currentExp) {
        currentExp.bullets.push(line.slice(2).trim());
        continue;
      }
    }

    if (currentSection === "skills" && line.startsWith("- ")) {
      skills.push(line.slice(2).trim());
    }
  }

  return { summary: summaryLines.join(" "), experience, skills };
}

/**
 * Generate a PDF from the candidate's CV markdown and profile.
 * Returns the filename (relative to outputDir) so the backend can serve it.
 */
export async function generateCvPdf(
  cvRaw: string,
  profile: any,
  filename: string,
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });

  const rawHtml = buildCvHtml(cvRaw, profile);
  const html = normalizeTextForATS(rawHtml);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => (document as any).fonts.ready);

    const outputPath = path.join(outputDir, filename);
    await page.pdf({
      format: "a4",
      printBackground: true,
      margin: {
        top: "0.6in",
        right: "0.6in",
        bottom: "0.6in",
        left: "0.6in",
      },
      preferCSSPageSize: false,
      path: outputPath,
    });

    console.log(`[pdf] generated: ${outputPath}`);
    return filename;
  } finally {
    await browser.close();
  }
}
