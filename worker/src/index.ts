import { getProfile, getCv, getArticleDigest } from "../../shared/src/index.ts";
import { buildReportFilename, slugify } from "../../shared/src/ops.ts";
import OpenAI from "openai";
import Redis from "ioredis";
import { Pool } from "pg";
import { generateCvPdf } from "./pdf.ts";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@postgres:5432/career_ops";
const jobQueueKey = process.env.JOB_QUEUE_KEY || "careerops:jobs";
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS || 10000);
const openrouterApiKey = process.env.OPENROUTER_API_KEY || "";

const redis = new Redis(redisUrl);
const pool = new Pool({ connectionString: databaseUrl });
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: openrouterApiKey,
});

// ─── System prompt — distilled from modes/_shared.md + modes/oferta.md ───────
const EVALUATION_SYSTEM_PROMPT = `You are career-ops, an AI job search assistant. Your job is to evaluate job offers for the candidate and generate a structured evaluation report.

## Sources of Truth
You will receive the candidate's CV and profile in the user message. Read them carefully before evaluating.

## Scoring System
Score the offer from 1 to 5 (one decimal place):
- 4.5+ → Strong match, recommend applying immediately
- 4.0–4.4 → Good match, worth applying
- 3.5–3.9 → Decent but not ideal, apply only if specific reason
- Below 3.5 → Recommend against applying

Score dimensions:
| Dimension | What it measures |
|-----------|-----------------|
| Match con CV | Skills, experience, proof points alignment |
| North Star alignment | How well the role fits the candidate's target archetypes |
| Comp | Salary vs market |
| Cultural signals | Company culture, growth, stability, remote policy |
| Red flags | Blockers, warnings (negative adjustments) |
| Global | Weighted average of above |

## Archetype Detection
Classify the offer into one of these types (or hybrid of 2):
- AI Platform / LLMOps — "observability", "evals", "pipelines", "monitoring", "reliability"
- Agentic / Automation — "agent", "HITL", "orchestration", "workflow", "multi-agent"
- Technical AI PM — "PRD", "roadmap", "discovery", "stakeholder", "product manager"
- AI Solutions Architect — "architecture", "enterprise", "integration", "design", "systems"
- AI Forward Deployed — "client-facing", "deploy", "prototype", "fast delivery", "field"
- AI Transformation — "change management", "adoption", "enablement", "transformation"

## Output Format
Always generate the complete report in this EXACT format (do not skip any block):

# Evaluación: {Company} — {Role}

**Fecha:** {YYYY-MM-DD}
**URL:** {url}
**Arquetipo:** {detected archetype}
**Score:** {X.X}/5
**Recomendación:** {one-line recommendation}

---

## A) Resumen del Rol

Table with: Arquetipo, Domain, Function, Seniority, Remote policy, Team size (if mentioned), TL;DR in 1 sentence.

## B) Match con CV

For each key JD requirement, map it to exact lines from the CV. Then list gaps with mitigation strategy (is it a hard blocker? adjacent experience? mitigation plan?).

## C) Nivel y Estrategia

1. Detected level in JD vs candidate's natural level for this archetype
2. "Sell senior without lying" plan: specific phrases adapted to archetype
3. "If downleveled" plan: accept if comp is fair, negotiate 6-month review

## D) Comp y Demanda

Research salary benchmarks for the role. If no data available, say so instead of inventing.
Table with data and cited sources.

## E) Plan de Personalización

| # | Sección | Estado actual | Cambio propuesto | Por qué |

Top 5 CV changes + Top 5 LinkedIn changes to maximize match.

## F) Plan de Entrevistas

6–10 STAR+R stories mapped to JD requirements:

| # | Requisito del JD | Historia STAR+R | S | T | A | R | Reflection |

Include: 1 recommended case study, red-flag questions and how to answer them.

---

## Keywords extraídas

List 15–20 keywords from the JD for ATS optimization.

## Global Rules
- NEVER invent experience or metrics
- NEVER use corporate-speak ("passionate about", "leveraged", "spearheaded", "synergies")
- Be direct and actionable — no fluff
- Cite exact lines from the CV when matching
- Generate content in the language of the JD (English by default)`;

function buildEvaluationUserMessage(
  url: string,
  jdText: string,
  cvRaw: string,
  profile: any,
  articleDigest: string,
): string {
  const targetRoles = Array.isArray(profile?.target_roles?.primary)
    ? profile.target_roles.primary.join(", ")
    : "N/A";
  const archetypes = Array.isArray(profile?.target_roles?.archetypes)
    ? profile.target_roles.archetypes
        .map((a: any) => `${a.name} (${a.level}, ${a.fit})`)
        .join("; ")
    : "N/A";
  const compRange = profile?.compensation?.target_range || "N/A";
  const location = profile?.location?.country || "N/A";
  const headline = profile?.narrative?.headline || "N/A";
  const superpowers = Array.isArray(profile?.narrative?.superpowers)
    ? profile.narrative.superpowers.join(", ")
    : "N/A";

  const digestSection = articleDigest.trim()
    ? `\n---\n\n## Proof Points & Portfolio (article-digest.md)\n\n${articleDigest}\n`
    : "";

  return `## Candidate Profile

**Target roles:** ${targetRoles}
**Target archetypes:** ${archetypes}
**Comp range:** ${compRange}
**Location:** ${location}
**Headline:** ${headline}
**Superpowers:** ${superpowers}

---

## Candidate CV

${cvRaw}
${digestSection}
---

## Job Offer to Evaluate

**URL:** ${url}

${jdText}

---

Please evaluate this job offer using the scoring system and generate the full A–F report.`;
}

function extractScoreFromMarkdown(markdown: string): number {
  const match = markdown.match(/\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/i);
  if (match) {
    const score = parseFloat(match[1]);
    if (!isNaN(score) && score >= 1 && score <= 5) return score;
  }
  return 3.0;
}

function extractArchetypeFromMarkdown(markdown: string): string {
  const match = markdown.match(/\*\*Arquetipo:\*\*\s*(.+)/i);
  return match ? match[1].trim() : "General AI / Automation";
}

function extractRecommendationFromMarkdown(markdown: string): string {
  const match = markdown.match(/\*\*Recomendaci[oó]n:\*\*\s*(.+)/i);
  return match ? match[1].trim() : "Review the evaluation for details.";
}

// ─── Database helpers ─────────────────────────────────────────────────────────

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL,
      result JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      filename TEXT,
      pdf_path TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS pdf_path TEXT;`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker (
      id SERIAL PRIMARY KEY,
      company TEXT,
      role TEXT,
      score NUMERIC,
      status TEXT,
      notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);
  await pool.query(
    `ALTER TABLE tracker ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_runs (
      id SERIAL PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      query_count INTEGER NOT NULL,
      result_count INTEGER NOT NULL,
      matched_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_results (
      id SERIAL PRIMARY KEY,
      scan_run_id INTEGER REFERENCES scan_runs(id) ON DELETE CASCADE,
      query_name TEXT,
      query TEXT,
      title TEXT,
      company TEXT,
      url TEXT,
      matched BOOLEAN,
      source TEXT,
      notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipeline_items (
      id SERIAL PRIMARY KEY,
      scan_run_id INTEGER REFERENCES scan_runs(id) ON DELETE SET NULL,
      url TEXT NOT NULL UNIQUE,
      company TEXT,
      title TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mode_results (
      id SERIAL PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      input JSONB,
      result TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);
}

async function createReport(
  jobId: number,
  title: string,
  body: string,
  filename: string,
) {
  const result = await pool.query(
    `INSERT INTO reports (job_id, title, body, filename) VALUES ($1, $2, $3, $4) RETURNING id`,
    [jobId, title, body, filename],
  );
  return result.rows[0].id as number;
}

async function updateReportPdfPath(reportId: number, pdfPath: string) {
  await pool.query(`UPDATE reports SET pdf_path = $1 WHERE id = $2`, [
    pdfPath,
    reportId,
  ]);
}

async function createTrackerEntry(job: any, evaluation: any) {
  const role = job.payload.role || "Unknown role";
  const company = job.payload.company || "Unknown company";
  // Dedup: check if entry exists for same company+role
  const existing = await pool.query(
    `SELECT id, score FROM tracker WHERE lower(company) = lower($1) AND lower(role) = lower($2) LIMIT 1`,
    [company, role],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    // Only update if new score is higher
    if (evaluation.score > parseFloat(existing.rows[0].score)) {
      await pool.query(
        `UPDATE tracker SET score = $1, notes = $2, updated_at = now() WHERE id = $3`,
        [evaluation.score, evaluation.recommendation, existing.rows[0].id],
      );
    }
  } else {
    await pool.query(
      `INSERT INTO tracker (company, role, score, status, notes) VALUES ($1, $2, $3, $4, $5)`,
      [company, role, evaluation.score, "Evaluated", evaluation.recommendation],
    );
  }
}

async function createScanRun(
  jobId: number,
  queryCount: number,
  resultCount: number,
  matchedCount: number,
  status: string,
  summary: string,
) {
  const result = await pool.query(
    `INSERT INTO scan_runs (job_id, query_count, result_count, matched_count, status, summary) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [jobId, queryCount, resultCount, matchedCount, status, summary],
  );
  return result.rows[0];
}

async function createPipelineItem(scanRunId: number, item: any) {
  const existing = await pool.query(
    `SELECT * FROM pipeline_items WHERE url = $1`,
    [item.url],
  );
  if (existing.rowCount > 0) {
    return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO pipeline_items (scan_run_id, url, company, title, source, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      scanRunId,
      item.url,
      item.company,
      item.title,
      item.source,
      item.status || "pending",
      item.notes || null,
    ],
  );
  return result.rows[0];
}

async function updatePipelineItemStatus(
  id: number,
  status: string,
  notes?: string,
) {
  await pool.query(
    `UPDATE pipeline_items SET status = $1, notes = $2, updated_at = now() WHERE id = $3`,
    [status, notes || null, id],
  );
}

async function createScanResult(scanRunId: number, result: any) {
  await pool.query(
    `INSERT INTO scan_results (scan_run_id, query_name, query, title, company, url, matched, source, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      scanRunId,
      result.query_name,
      result.query,
      result.title,
      result.company,
      result.url,
      result.matched,
      result.source,
      result.notes,
    ],
  );
}

// ─── Scan helpers (unchanged from original) ───────────────────────────────────

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[""«»]/g, "")
    .trim();
}

function matchesTitleFilter(title: string, filter: any) {
  const normalized = normalizeText(title);
  const positive = Array.isArray(filter?.positive) ? filter.positive : [];
  const negative = Array.isArray(filter?.negative) ? filter.negative : [];
  const hasPositive = positive.some((keyword: string) =>
    normalized.includes(keyword.toLowerCase()),
  );
  const hasNegative = negative.some((keyword: string) =>
    normalized.includes(keyword.toLowerCase()),
  );
  return hasPositive && !hasNegative;
}

function extractCompanyFromTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  const patterns = [/@|\s+at\s+|\||–|—/];
  for (const pattern of patterns) {
    const parts = normalized.split(pattern as RegExp);
    if (parts.length >= 2) {
      return parts[1].trim();
    }
  }
  return "Unknown company";
}

function buildSearchResultFromQuery(query: any, item: any) {
  const queryName = query.name || "Unknown query";
  const title = item.title || item.name || "Untitled role";
  const company = item.company || extractCompanyFromTitle(title);
  return {
    query_name: queryName,
    query: query.query || "",
    title,
    company,
    url: item.url,
    source: item.source || "websearch",
    notes: item.notes || "Discovered via portals.yml search query",
  };
}

async function fetchSearchResults(searchQuery: string) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(
      searchQuery,
    )}&mkt=en-US`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CareerOps/1.0; +https://example.com)",
      },
    });
    if (!response.ok) {
      throw new Error(`Search request failed: ${response.status}`);
    }
    const html = await response.text();
    const regex =
      /<li[^>]*class="b_algo"[\s\S]*?<h2>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const results: Array<{ url: string; title: string }> = [];
    let match;
    while ((match = regex.exec(html)) && results.length < 10) {
      const url = match[1];
      const title = match[2]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (url && title) {
        results.push({ url, title });
      }
    }
    return results;
  } catch (error) {
    console.error("[worker] fetchSearchResults failed", error);
    return [];
  }
}

async function fetchGreenhouseJobs(apiUrl: string) {
  try {
    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CareerOps/1.0; +https://example.com)",
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Greenhouse API request failed: ${response.status}`);
    }

    const data = await response.json();
    const jobs = Array.isArray(data.jobs)
      ? data.jobs
      : Array.isArray(data.jobs?.results)
        ? data.jobs.results
        : [];

    return jobs
      .filter((job: any) => job.absolute_url || job.apply_url || job.url)
      .map((job: any) => ({
        url: job.absolute_url || job.apply_url || job.url,
        title: job.title || job.name || "Untitled role",
        company: job.company || "",
        source: "tracked_company_greenhouse_api",
        notes: "Fetched from Greenhouse API",
      }));
  } catch (error) {
    console.error("[worker] fetchGreenhouseJobs failed", error);
    return [];
  }
}

function normalizeUrl(url: string, base?: string) {
  try {
    return new URL(url, base).href.replace(/#.*$/, "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

function extractJobLinksFromHtml(html: string, baseUrl: string) {
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  const jobs: Array<any> = [];
  const seen = new Set<string>();
  let match;

  while ((match = regex.exec(html))) {
    const rawUrl = match[1].trim();
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    if (!rawUrl || !title) continue;

    const url = normalizeUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) continue;

    seen.add(url);
    jobs.push({
      url,
      title,
      company: "",
      source: "tracked_company_page",
      notes: "Extracted from company careers page",
    });

    if (jobs.length >= 50) break;
  }

  return jobs;
}

async function fetchCompanyJobs(company: any) {
  if (!company.careers_url) return [];
  try {
    const response = await fetch(company.careers_url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CareerOps/1.0; +https://example.com)",
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch careers URL ${company.careers_url}: ${response.status}`,
      );
    }

    const html = await response.text();
    return extractJobLinksFromHtml(html, company.careers_url);
  } catch (error) {
    console.error("[worker] fetchCompanyJobs failed", company.name, error);
    return [];
  }
}

async function fetchTrackedCompanyResults(company: any) {
  if (company.enabled === false) return [];

  if (company.api) {
    const items = await fetchGreenhouseJobs(company.api);
    if (items.length > 0) {
      return items.map((item: any) => ({
        ...item,
        company: item.company || company.name,
        query_name: company.name,
      }));
    }
  }

  if (company.scan_method === "websearch" && company.scan_query) {
    const items = await fetchSearchResults(company.scan_query);
    return items.map((item: any) => ({
      ...item,
      company: company.name,
      source: "tracked_company_websearch",
      notes: "Discovered by tracked company websearch",
      query_name: company.name,
    }));
  }

  if (company.careers_url) {
    const items = await fetchCompanyJobs(company);
    return items.map((item: any) => ({
      ...item,
      company: company.name,
      source: item.source || "tracked_company_page",
      query_name: company.name,
    }));
  }

  return [];
}

// ─── Job runners ──────────────────────────────────────────────────────────────

async function runScan(job: any) {
  const titleFilter = job.payload.title_filter || {};
  const queries = Array.isArray(job.payload.search_queries)
    ? job.payload.search_queries
    : [];
  const trackedCompanies = Array.isArray(job.payload.tracked_companies)
    ? job.payload.tracked_companies
    : [];

  const rawCandidates: Array<{ query: any; item: any }> = [];

  for (const query of queries) {
    const items = await fetchSearchResults(query.query || query.name || "");
    for (const item of items) {
      rawCandidates.push({ query, item });
    }
  }

  for (const company of trackedCompanies) {
    const items = await fetchTrackedCompanyResults(company);
    for (const item of items) {
      rawCandidates.push({
        query: {
          name: company.name,
          query: company.scan_query || company.careers_url || company.name,
        },
        item,
      });
    }
  }

  const candidatesByUrl = new Map<string, any>();
  for (const entry of rawCandidates) {
    const result = buildSearchResultFromQuery(entry.query, entry.item);
    const normalizedUrl = normalizeUrl(result.url || "");
    if (!normalizedUrl || candidatesByUrl.has(normalizedUrl)) continue;
    candidatesByUrl.set(normalizedUrl, { ...result, url: normalizedUrl });
  }

  const candidates = Array.from(candidatesByUrl.values()).map((candidate) => {
    const matched = matchesTitleFilter(candidate.title, titleFilter);
    return {
      ...candidate,
      matched,
      notes: matched
        ? "Title filter passed"
        : "Title filter did not match positive keywords or matched a negative keyword",
    };
  });

  const matchedCount = candidates.filter((item) => item.matched).length;
  const scanRun = await createScanRun(
    job.id,
    queries.length + trackedCompanies.length,
    candidates.length,
    matchedCount,
    "completed",
    `Scan generated ${matchedCount} matched candidate(s)`,
  );

  for (const candidate of candidates) {
    await createScanResult(scanRun.id, candidate);
    if (candidate.matched) {
      await createPipelineItem(scanRun.id, {
        url: candidate.url,
        company: candidate.company,
        title: candidate.title,
        source: candidate.source,
        status: "pending",
        notes: "Matched by scan and added to pipeline",
      });
    }
  }

  return {
    scanRun,
    summary: `Scan completed with ${matchedCount}/${candidates.length} results matched`,
  };
}

async function extractTextFromHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const EXPIRED_URL_PATTERNS = [/[?&]error=true/i];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

/**
 * Checks if a job URL is still active using a lightweight HTTP fetch.
 * Returns 'active' | 'expired' | 'uncertain'.
 */
async function checkLiveness(
  url: string,
): Promise<{ result: "active" | "expired" | "uncertain"; reason: string }> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });

    if (response.status === 404 || response.status === 410) {
      return { result: "expired", reason: `HTTP ${response.status}` };
    }

    const finalUrl = response.url;
    for (const pattern of EXPIRED_URL_PATTERNS) {
      if (pattern.test(finalUrl)) {
        return { result: "expired", reason: `redirect to ${finalUrl}` };
      }
    }

    const bodyText = await response.text();

    if (APPLY_PATTERNS.some((p) => p.test(bodyText))) {
      return { result: "active", reason: "apply button detected" };
    }

    for (const pattern of EXPIRED_PATTERNS) {
      if (pattern.test(bodyText)) {
        return {
          result: "expired",
          reason: `pattern matched: ${pattern.source}`,
        };
      }
    }

    if (bodyText.trim().length < MIN_CONTENT_CHARS) {
      return {
        result: "expired",
        reason: "insufficient content — likely nav/footer only",
      };
    }

    return { result: "uncertain", reason: "content present but no apply button found" };
  } catch (err) {
    return {
      result: "expired",
      reason: `fetch error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }
}

async function fetchJobDescription(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CareerOps/1.0; +https://example.com)",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const html = await response.text();
    return (await extractTextFromHtml(html)).slice(0, 8000);
  } catch (error) {
    console.error("[worker] fetchJobDescription failed", error);
    return "";
  }
}

async function runEvaluation(job: any) {
  if (!openrouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Cannot run AI evaluation.",
    );
  }

  const profile = await getProfile();
  const cv = await getCv();
  const articleDigest = await getArticleDigest();

  const url = job.payload.url || "";
  const jdText = job.payload.text || "";
  const company = job.payload.company || "Unknown company";
  const role = job.payload.role || "Unknown role";

  console.log(`[worker] calling Claude API for evaluation: ${url}`);

  const userMessage = buildEvaluationUserMessage(url, jdText, cv.raw, profile, articleDigest);

  const response = await openai.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-5",
    max_tokens: 4096,
    messages: [
      { role: "system", content: EVALUATION_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const markdown = response.choices[0]?.message?.content ?? "";

  const score = extractScoreFromMarkdown(markdown);
  const archetype = extractArchetypeFromMarkdown(markdown);
  const recommendation = extractRecommendationFromMarkdown(markdown);

  const date = new Date().toISOString().slice(0, 10);
  const seqResult = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM reports`);
  const seqNum = String(seqResult.rows[0].next).padStart(3, "0");
  const reportFilename = `${seqNum}-${buildReportFilename(company, role, date)}`;

  const reportId = await createReport(
    job.id,
    `Evaluation: ${company} — ${role}`,
    markdown,
    reportFilename,
  );

  // Generate CV PDF after successful evaluation
  try {
    const pdfFilename = `${date}-${slugify(company)}-${slugify(role)}.pdf`;
    const pdfPath = await generateCvPdf(cv.raw, profile, pdfFilename);
    await updateReportPdfPath(reportId, pdfPath);
    console.log(`[worker] PDF generated: ${pdfPath}`);
  } catch (pdfError) {
    console.error("[worker] PDF generation failed (non-fatal)", pdfError);
  }

  await createTrackerEntry(job, { score, recommendation });

  return { score, archetype, recommendation, reportFilename };
}

async function runPipelineProcess(job: any) {
  const itemsResult = await pool.query(
    `SELECT * FROM pipeline_items WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`,
  );
  const items = itemsResult.rows;
  let queuedCount = 0;

  for (const item of items) {
    const { result: liveness, reason } = await checkLiveness(item.url);
    if (liveness === "expired") {
      console.log(`[worker] liveness: dead — ${item.url} (${reason})`);
      await updatePipelineItemStatus(item.id, "dead", `URL dead: ${reason}`);
      continue;
    }
    if (liveness === "uncertain") {
      console.log(`[worker] liveness: uncertain — ${item.url} (${reason}), proceeding anyway`);
    }

    const descriptionText = await fetchJobDescription(item.url);
    const payload = {
      url: item.url,
      text: descriptionText || `Job page fetched from ${item.url}`,
      company: item.company || "Unknown company",
      role: item.title || "Unknown role",
    };
    const insert = await pool.query(
      `INSERT INTO jobs (type, status, payload) VALUES ($1, $2, $3) RETURNING *`,
      ["evaluate", "pending", payload],
    );
    await redis.lpush(
      jobQueueKey,
      JSON.stringify({ jobId: insert.rows[0].id, type: "evaluate" }),
    );
    await updatePipelineItemStatus(
      item.id,
      "queued",
      `Queued evaluation job ${insert.rows[0].id}`,
    );
    queuedCount++;
  }

  return {
    processedCount: items.length,
    queuedCount,
    summary: `Queued ${queuedCount} evaluation jobs from ${items.length} pipeline items`,
  };
}

// ─── Mode system prompts ──────────────────────────────────────────────────────

const MODE_PROMPTS: Record<string, string> = {
  ofertas: `You are career-ops. Compare multiple job offers and rank them for the candidate.

Scoring matrix — 10 weighted dimensions (score each 1-5):
| Dimension | Weight |
|-----------|--------|
| North Star alignment | 25% |
| CV match | 15% |
| Seniority level (senior+) | 15% |
| Estimated compensation | 10% |
| Growth trajectory | 10% |
| Remote quality | 5% |
| Company reputation | 5% |
| Tech stack modernity | 5% |
| Speed to offer | 5% |
| Cultural signals | 5% |

For each offer: score per dimension, weighted total, final ranking.
Output a ranked comparison table + recommendation considering time-to-offer.
The candidate's CV and profile will be provided in the user message.`,

  "interview-prep": `You are career-ops. Generate a company-specific interview preparation report.

Structure your report with these sections:
1. Process Overview (rounds, format, difficulty, timeline)
2. Round-by-Round Breakdown (what each round tests, reported questions)
3. Likely Questions — Technical, Behavioral, Role-Specific, Background Red Flags
4. Story Mapping (which candidate stories map to which questions)
5. Technical Prep Checklist (max 10 items, prioritized by frequency)
6. Company Signals (values, vocabulary to use, things to avoid, questions to ask)

Rules:
- NEVER invent questions and attribute them to sources. Label inferred questions [inferred from JD].
- NEVER fabricate ratings or statistics. If data isn't available, say so.
- Cite everything. Every claim gets a source or [inferred] tag.
- Be direct — this is a working prep document, not a pep talk.

The candidate's CV, profile, and job details will be provided in the user message.`,

  contacto: `You are career-ops. Generate a LinkedIn outreach strategy for the candidate applying to a specific company and role.

Steps:
1. Identify the right targets: hiring manager, assigned recruiter, 2-3 peers in similar roles
2. Select the primary target (person who most benefits from the candidate joining)
3. Generate a connection message using the 3-sentence framework:
   - Hook: Something specific about their company's AI challenge (NOT generic)
   - Proof: Candidate's biggest quantifiable achievement relevant to THIS role
   - Proposal: Quick chat, no pressure ("Would love to chat about [specific topic] for 15 min")
4. Provide alternative targets with justification

Message rules:
- Maximum 300 characters (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Something that makes them want to respond
- NEVER share phone number

The candidate's CV and profile will be provided in the user message.`,

  deep: `You are career-ops. Generate a structured deep research report on a company for interview preparation.

Cover these 6 axes:

1. AI Strategy
   - Which products/features use AI/ML?
   - What is their AI stack? (models, infra, tools)
   - Do they have an engineering blog? What do they publish?
   - Any papers or talks about AI?

2. Recent Moves (last 6 months)
   - Relevant hires in AI/ML/product?
   - Acquisitions or partnerships?
   - Product launches or pivots?
   - Funding rounds or leadership changes?

3. Engineering Culture
   - How do they ship? (deploy cadence, CI/CD)
   - Mono-repo or multi-repo?
   - Languages/frameworks?
   - Remote-first or office-first?
   - Glassdoor/Blind reviews on eng culture?

4. Likely Challenges
   - What scaling problems do they have?
   - Reliability, cost, latency challenges?
   - Are they migrating anything? (infra, models, platforms)
   - What pain points does the team mention in reviews?

5. Competitors & Differentiation
   - Who are their main competitors?
   - What is their moat/differentiator?
   - How do they position vs competition?

6. Candidate Angle
   Given the candidate's profile (from CV and profile provided):
   - What unique value do they bring to this team?
   - Which of their projects are most relevant?
   - What story should they tell in the interview?

The candidate's CV, profile, and target company/role will be provided in the user message.`,

  apply: `You are career-ops. Help the candidate fill out a job application form.

Given the form questions provided, generate ready-to-paste responses for each question.

For each response:
1. Use proof points from the candidate's CV
2. Use the "I'm choosing you" tone (specific, confident, not generic)
3. Reference something concrete from the job description
4. Keep responses concise and impactful

Output format:
## Application Responses — [Company] — [Role]

---

### 1. [Exact question from form]
> [Ready to paste response]

### 2. [Next question]
> [Response]

---

Notes:
- [Any observations about the role or form]
- [Personalization suggestions the candidate should review]

IMPORTANT: NEVER submit the application. Always stop before clicking Submit/Send/Apply.

The candidate's CV, profile, and form questions will be provided in the user message.`,

  training: `You are career-ops. Evaluate a course or certification for the candidate.

Score 6 dimensions:
| Dimension | What it evaluates |
|-----------|-------------------|
| North Star alignment | Does it move toward or away from target roles? |
| Recruiter signal | What do HMs think when they see this on a CV? |
| Time and effort | Weeks × hours/week |
| Opportunity cost | What can't they do during that time? |
| Risks | Outdated content? Weak brand? Too basic? |
| Portfolio deliverable | Does it produce a demonstrable artifact? |

Verdicts:
- DO IT → 4-12 week plan with weekly deliverables
- DON'T DO IT → better alternative with justification
- DO IT WITH TIMEBOX (max X weeks) → condensed plan, essentials only

Priority for training that improves credibility in "production-grade AI":
1. LLM evals and testing
2. Observability and monitoring
3. Cost/reliability trade-offs
4. AI governance and safety
5. Enterprise AI architecture

The candidate's CV and profile will be provided in the user message.`,

  project: `You are career-ops. Evaluate a portfolio project idea for the candidate.

Score 6 dimensions (1-5):
| Dimension | Weight | 5 = ... | 1 = ... |
|-----------|--------|---------|---------|
| Signal for target roles | 25% | Directly demonstrates JD skill | Unrelated |
| Uniqueness | 20% | Nobody has done this | Everyone has it |
| Demo-ability | 20% | Live demo in 2 min | Code only, not visual |
| Metrics potential | 15% | Clear metrics (latency, cost, accuracy) | No metrics possible |
| Time to MVP | 10% | 1 week | 3+ months |
| STAR story potential | 10% | Rich story with trade-offs | Just implementation |

Interview Pack requirements for approved projects:
1. One-pager: product + architecture + metrics + evaluation plan
2. Demo: live URL or 2-min recorded walkthrough
3. Postmortem: what worked, what didn't, mitigations

80/20 Plan:
- Week 1 → MVP with core metric
- Week 2 → polish + interview pack

Verdicts:
- BUILD → plan with weekly milestones
- SKIP → why and what to do instead
- PIVOT TO [alternative] → more impactful variant

The candidate's CV, profile, and project idea will be provided in the user message.`,

  patterns: `You are career-ops. Analyze the candidate's application history to find patterns in outcomes.

You will receive tracker data (list of applications with status, score, company, role, archetype).

Analyze:
1. Conversion Funnel — count and % at each stage (Evaluated → Applied → Interview → Offer)
2. Score vs Outcome — avg/min/max score per outcome group (positive, negative, self-filtered, pending)
3. Archetype Performance — conversion rate per archetype type
4. Top Blockers — recurring hard blockers (geo-restriction, stack-mismatch, seniority)
5. Remote Policy Patterns — conversion rate by remote policy type
6. Recommended Score Threshold — data-driven minimum score

Outcome classification:
- Positive: Interview, Offer, Responded, Applied
- Negative: Rejected, Discarded
- Self-filtered: SKIP
- Pending: Evaluated

End with 3-5 specific, actionable recommendations.

The tracker data will be provided in the user message.`,
};

async function saveModeResult(
  jobId: number,
  mode: string,
  input: object,
  result: string,
) {
  await pool.query(
    `INSERT INTO mode_results (job_id, mode, input, result) VALUES ($1, $2, $3, $4)`,
    [jobId, mode, input, result],
  );
}

async function runMode(job: any) {
  const { mode, ...input } = job.payload;
  const systemPrompt = MODE_PROMPTS[mode];
  if (!systemPrompt) {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const [{ raw: cvRaw }, profile, articleDigest] = await Promise.all([
    getCv(),
    getProfile(),
    getArticleDigest(),
  ]);

  // Build user message contextualizing the candidate's data
  let userMessage = `## Candidate CV\n\n${cvRaw}\n\n`;
  userMessage += `## Candidate Profile\n\n${JSON.stringify(profile, null, 2)}\n\n`;
  if (articleDigest) {
    userMessage += `## Portfolio / Proof Points\n\n${articleDigest}\n\n`;
  }

  // For patterns mode, include tracker data from DB
  if (mode === "patterns") {
    const trackerResult = await pool.query(
      `SELECT company, role, score, status, notes, created_at FROM tracker ORDER BY created_at DESC`,
    );
    userMessage += `## Application Tracker Data\n\n${JSON.stringify(trackerResult.rows, null, 2)}\n\n`;
    if (trackerResult.rowCount === 0 || trackerResult.rowCount! < 5) {
      return {
        result: `Not enough data yet — ${trackerResult.rowCount ?? 0}/5 applications tracked. Keep applying and come back when you have more outcomes to analyze.`,
      };
    }
  }

  // Append mode-specific input fields
  const inputKeys = Object.keys(input).filter((k) => input[k as keyof typeof input]);
  for (const key of inputKeys) {
    userMessage += `## ${key.charAt(0).toUpperCase() + key.slice(1)}\n\n${input[key as keyof typeof input]}\n\n`;
  }

  const response = await openai.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-5",
    max_tokens: 4096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  const resultText = response.choices[0]?.message?.content ?? "";

  await saveModeResult(job.id, mode, input, resultText);
  return { result: resultText };
}

async function processJob(rawPayload: string) {
  const jobData = JSON.parse(rawPayload);
  const jobId = jobData.jobId;
  console.log("[worker] processing job", jobId, jobData.type);

  try {
    const jobResult = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [
      jobId,
    ]);
    if (jobResult.rowCount === 0) {
      console.error("[worker] job not found", jobId);
      return;
    }

    const job = jobResult.rows[0];

    if (jobData.type === "scan") {
      const scanResult = await runScan(job);
      await pool.query(
        `UPDATE jobs SET status = $1, result = $2, updated_at = now() WHERE id = $3`,
        [
          "completed",
          {
            summary: scanResult.summary,
            matchedCount: scanResult.scanRun.matched_count,
            totalResults: scanResult.scanRun.result_count,
            processedAt: new Date().toISOString(),
          },
          jobId,
        ],
      );
      console.log("[worker] completed scan job", jobId);
      return;
    }

    if (jobData.type === "pipeline_process") {
      const result = await runPipelineProcess(job);
      await pool.query(
        `UPDATE jobs SET status = $1, result = $2, updated_at = now() WHERE id = $3`,
        ["completed", result, jobId],
      );
      console.log("[worker] completed pipeline_process job", jobId);
      return;
    }

    const VALID_MODES = ["ofertas", "interview-prep", "contacto", "deep", "apply", "training", "project", "patterns"];
    if (VALID_MODES.includes(jobData.type)) {
      const modeResult = await runMode(job);
      await pool.query(
        `UPDATE jobs SET status = $1, result = $2, updated_at = now() WHERE id = $3`,
        ["completed", modeResult, jobId],
      );
      console.log("[worker] completed mode job", jobId, jobData.type);
      return;
    }

    // Default: evaluate
    const evaluation = await runEvaluation(job);
    await pool.query(
      `UPDATE jobs SET status = $1, result = $2, updated_at = now() WHERE id = $3`,
      [
        "completed",
        {
          score: evaluation.score,
          archetype: evaluation.archetype,
          recommendation: evaluation.recommendation,
          reportFilename: evaluation.reportFilename,
          processedAt: new Date().toISOString(),
        },
        jobId,
      ],
    );
    console.log("[worker] completed evaluate job", jobId);
  } catch (error) {
    console.error("[worker] failed job", jobId, error);
    await pool.query(
      `UPDATE jobs SET status = $1, result = $2, updated_at = now() WHERE id = $3`,
      [
        "failed",
        { error: error instanceof Error ? error.message : "Unknown error" },
        jobId,
      ],
    );
  }
}

async function listenQueue() {
  while (true) {
    try {
      const payload = await redis.brpop(jobQueueKey, 0);
      if (!payload) continue;
      const [, rawJob] = payload;
      await processJob(rawJob);
    } catch (error) {
      console.error("[worker] queue error", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function start() {
  console.log("[worker] started");
  if (!openrouterApiKey) {
    console.warn(
      "[worker] WARNING: OPENROUTER_API_KEY is not set. Evaluation jobs will fail.",
    );
  }
  await initDatabase();
  listenQueue().catch((error) => {
    console.error("[worker] listener crashed", error);
    process.exit(1);
  });
  setInterval(() => {
    console.log("[worker] heartbeat", new Date().toISOString());
  }, heartbeatMs);
}

start().catch((error) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
