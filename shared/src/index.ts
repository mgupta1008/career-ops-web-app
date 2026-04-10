import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedRoot = path.resolve(__dirname, "..");
const dataDir = path.join(sharedRoot, "data");
const profilePath = path.join(dataDir, "profile.yml");
const cvPath = path.join(dataDir, "cv.md");
const articleDigestPath = path.join(dataDir, "article-digest.md");

export async function getProfile() {
  const raw = await fs.readFile(profilePath, "utf8");
  return parse(raw);
}

function parseCvMarkdown(raw: string) {
  const lines = raw.split(/\r?\n/);
  let currentSection = "summary";
  let currentExperience: {
    company: string;
    role: string;
    bullets: string[];
  } | null = null;
  const experience: Array<{
    company: string;
    role: string;
    bullets: string[];
  }> = [];
  const skills: string[] = [];
  const summaryLines: string[] = [];
  let title = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }

    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim().toLowerCase();
      currentExperience = null;
      continue;
    }

    if (currentSection === "summary") {
      summaryLines.push(line);
      continue;
    }

    if (currentSection === "experience") {
      if (line.startsWith("### ")) {
        const sectionText = line.slice(4).trim();
        const [companyPart, rolePart] = sectionText
          .split("—")
          .map((item) => item.trim());
        currentExperience = {
          company: companyPart || sectionText,
          role: rolePart || "",
          bullets: [],
        };
        experience.push(currentExperience);
        continue;
      }

      if (line.startsWith("- ") && currentExperience) {
        currentExperience.bullets.push(line.slice(2).trim());
        continue;
      }
    }

    if (currentSection === "skills") {
      if (line.startsWith("- ")) {
        skills.push(line.slice(2).trim());
      }
      continue;
    }
  }

  return {
    title,
    summary: summaryLines.join(" "),
    experience,
    skills,
  };
}

export async function getCv() {
  const raw = await fs.readFile(cvPath, "utf8");
  return {
    raw,
    parsed: parseCvMarkdown(raw),
  };
}

/** Returns article-digest.md content, or empty string if file doesn't exist. */
export async function getArticleDigest(): Promise<string> {
  try {
    return await fs.readFile(articleDigestPath, "utf8");
  } catch {
    return "";
  }
}
