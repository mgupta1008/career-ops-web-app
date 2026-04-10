import { getProfile, getCv } from "./index.ts";

const archetypes = [
  {
    name: "AI Platform / LLMOps Engineer",
    keywords: [
      "observability",
      "monitoring",
      "evaluation",
      "pipelines",
      "reliability",
      "llmops",
      "production",
    ],
  },
  {
    name: "Agentic Workflows / Automation",
    keywords: [
      "agents",
      "orchestration",
      "workflow",
      "automation",
      "hitl",
      "multi-agent",
      "orchestrator",
    ],
  },
  {
    name: "Technical AI Product Manager",
    keywords: [
      "product",
      "roadmap",
      "discovery",
      "stakeholder",
      "requirements",
      "go-to-market",
      "pm",
    ],
  },
  {
    name: "AI Solutions Architect",
    keywords: [
      "architecture",
      "integration",
      "enterprise",
      "design",
      "cloud",
      "system",
      "solution",
    ],
  },
  {
    name: "AI Forward Deployed Engineer",
    keywords: [
      "delivery",
      "client-facing",
      "prototype",
      "fast",
      "customer",
      "deployment",
      "iteration",
    ],
  },
  {
    name: "AI Transformation Lead",
    keywords: [
      "change",
      "adoption",
      "enablement",
      "transformation",
      "org",
      "culture",
      "strategy",
    ],
  },
];

export function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[“”«»]/g, "")
    .replace(/[\s\n\r]+/g, " ")
    .trim();
}

export function extractKeywords(text: string) {
  const normalized = normalizeText(text);
  const tokens = Array.from(
    new Set(normalized.match(/\b[a-z0-9]{4,}\b/g) || []),
  );
  return tokens.filter((token) => token.length >= 4);
}

export function detectArchetype(jdText: string) {
  const jd = normalizeText(jdText);
  const scores = archetypes.map((item) => {
    const matches = item.keywords.reduce((count, keyword) => {
      return count + (jd.includes(keyword) ? 1 : 0);
    }, 0);
    return { name: item.name, score: matches };
  });

  const sorted = scores.sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const second = sorted[1];

  if (top.score === 0) {
    return { archetype: "General AI / Automation", details: [top.name] };
  }

  if (second.score >= Math.max(1, top.score - 1)) {
    return {
      archetype: `${top.name} / ${second.name}`,
      details: [top.name, second.name],
    };
  }

  return { archetype: top.name, details: [top.name] };
}

function collectCvVocabulary(profile: any, cv: any) {
  const parts: string[] = [];
  if (profile?.target_roles?.primary) {
    parts.push(...profile.target_roles.primary);
  }
  if (cv?.parsed?.skills) {
    parts.push(...cv.parsed.skills);
  }
  if (cv?.parsed?.summary) {
    parts.push(cv.parsed.summary);
  }
  return Array.from(
    new Set(
      parts
        .join(" ")
        .toLowerCase()
        .match(/\b[a-z0-9]{4,}\b/g) || [],
    ),
  );
}

export function calculateMatchScore(jdText: string, profile: any, cv: any) {
  const jdKeywords = extractKeywords(jdText);
  const cvVocabulary = collectCvVocabulary(profile, cv);
  const hits = jdKeywords.filter((keyword) =>
    cvVocabulary.includes(keyword),
  ).length;
  const ratio = jdKeywords.length ? hits / jdKeywords.length : 0;
  return Math.min(5, Math.max(1, Math.round(ratio * 5)));
}

export function makeRecommendation(score: number) {
  if (score >= 4) return "Strong match — consider applying.";
  if (score >= 3) return "Moderate match — review details before applying.";
  return "Low match — use only if you want to explore the role.";
}

function formatList(items: string[]) {
  if (items.length === 0) return "N/A";
  return items.map((item) => `- ${item}`).join("\n");
}

function excerptText(text: string, limit = 120) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}...`;
}

export function buildReportFilename(
  company: string,
  role: string,
  date: string,
) {
  return `${date}-${slugify(company)}-${slugify(role)}.md`;
}

export function createReportMarkdown(opts: {
  url: string;
  company: string;
  role: string;
  archetype: string;
  score: number;
  recommendation: string;
  summary: string;
  keywords: string[];
  profile: any;
  cv: any;
}) {
  const {
    url,
    company,
    role,
    archetype,
    score,
    recommendation,
    summary,
    keywords,
    profile,
    cv,
  } = opts;
  const targetRoles = Array.isArray(profile?.target_roles?.primary)
    ? profile.target_roles.primary.join(", ")
    : "N/A";
  const skills = Array.isArray(cv?.parsed?.skills)
    ? cv.parsed.skills.join(", ")
    : "N/A";
  const summaryExcerpt = excerptText(summary, 200);

  return `# Evaluación: ${company} — ${role}

**Fecha:** ${new Date().toISOString().slice(0, 10)}
**URL:** ${url}
**Arquetipo:** ${archetype}
**Score:** ${score}/5
**Recomendación:** ${recommendation}

---

## A) Resumen del Rol

- Arquetipo detectado: ${archetype}
- Nivel sugerido: Senior / Technical Builder
- Objetivo principal: alinear el CV con métricas, delivery y fiabilidad
- Roles objetivo del candidato: ${targetRoles}

## B) Match con CV

### Habilidades clave extraídas del CV
${formatList(Array.isArray(cv?.parsed?.skills) ? cv.parsed.skills : [])}

### Qué está bien alineado
- Resumen enfocado en delivery y automation
- Experiencia relevante en proyectos de prototipado y producción
- Uso de métricas y sistemas observables en el CV

### Gaps potenciales
- Si el JD pide enfoque explícito en “change management”, recomendar historias de adopción
- Si el JD pide “agent orchestration”, destacar cualquier experiencia de automatización de flujos

## C) Nivel y Estrategia

- Nivel natural del candidato: senior / technical builder
- Estrategia de posicionamiento: enfatizar experiencia de entrega rápida, observabilidad y escalabilidad
- Downlevel plan: aceptar nivel más bajo si la comp es justa y hay camino claro a revisión

## D) Plan de Personalización

### Cambios rápidos al CV
${formatList([
  "Alinear el resumen con keywords del JD",
  "Reordenar bullets por impacto en delivery y métricas",
  "Agregar métricas cuantificables en al menos 1-2 bullets relevantes",
])}

### Cambios a LinkedIn
${formatList([
  "Enfatizar capacidad de traducir discovery en soluciones productivas",
  "Incluir palabras clave de automation, observability y production",
  "Mostrar experiencia con equipos cross-functional y entregas rápidas",
])}

## E) Plan de Entrevistas

- Historias recomendadas: entrega de sistemas en producción, enfoque en métricas, adaptación de requisitos
- Pregunta clave a preparar: “Describe un proyecto donde tuviste que balancear velocidad y calidad en producción”
- Red flag a anticipar: falta de métricas en el resultado → responder con datos de impacto

## F) Keywords extraídas

${keywords.slice(0, 20).join(", ")}

---

## Resumen automático

${summaryExcerpt}
`;
}

export function buildReportResult(
  url: string,
  company: string,
  role: string,
  jdText: string,
  profile: any,
  cv: any,
) {
  const { archetype } = detectArchetype(jdText);
  const score = calculateMatchScore(jdText, profile, cv);
  const recommendation = makeRecommendation(score);
  const summary = `Evaluación automática basada en coincidencias de keywords entre el JD y el perfil/CV. Score ${score}/5.`;
  const keywords = extractKeywords(jdText).slice(0, 20);

  const date = new Date().toISOString().slice(0, 10);
  return {
    archetype,
    score,
    recommendation,
    summary,
    keywords,
    reportFilename: buildReportFilename(company, role, date),
    markdown: createReportMarkdown({
      url,
      company,
      role,
      archetype,
      score,
      recommendation,
      summary,
      keywords,
      profile,
      cv,
    }),
  };
}

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[\s\/\\]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}
