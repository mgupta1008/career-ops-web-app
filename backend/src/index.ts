import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { getProfile, getCv } from "../../shared/src/index.ts";
import { buildReportFilename } from "../../shared/src/ops.ts";
import Redis from "ioredis";
import { Pool } from "pg";

const portalsPath = path.join(process.cwd(), "portals.yml");
const port = Number(process.env.PORT || 5001);
const pdfOutputDir = process.env.PDF_OUTPUT_DIR || "/app/output";
const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@postgres:5432/career_ops";
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const jobQueueKey = process.env.JOB_QUEUE_KEY || "careerops:jobs";

const pool = new Pool({ connectionString: databaseUrl });
const redis = new Redis(redisUrl);
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

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
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);
  await pool.query(
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS filename TEXT;`,
  );
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

  await pool.query(
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS pdf_path TEXT;`,
  );

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

async function loadPortalsConfig() {
  try {
    const raw = await fs.readFile(portalsPath, "utf8");
    return parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to load portals.yml from ${portalsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
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

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "backend" });
});

app.get("/v1/profile", async (req, res) => {
  try {
    const profile = await getProfile();
    res.json(profile);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/v1/cv", async (req, res) => {
  try {
    const cv = await getCv();
    res.json(cv);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/v1/jobs", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch jobs",
    });
  }
});

app.get("/v1/reports", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM reports ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch reports",
    });
  }
});

app.get("/v1/tracker", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tracker ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch tracker",
    });
  }
});

app.post("/v1/evaluate", async (req, res) => {
  try {
    const { url, text, company, role } = req.body;

    if (!url || !text) {
      return res
        .status(400)
        .json({ error: "Missing required fields: url, text" });
    }

    const payload = {
      url,
      text,
      company: company || "Unknown company",
      role: role || "Unknown role",
    };
    const insert = await pool.query(
      `INSERT INTO jobs (type, status, payload) VALUES ($1, $2, $3) RETURNING *`,
      ["evaluate", "pending", payload],
    );

    const expectedReportFilename = buildReportFilename(
      payload.company,
      payload.role,
      new Date().toISOString().slice(0, 10),
    );

    await redis.lpush(
      jobQueueKey,
      JSON.stringify({ jobId: insert.rows[0].id, type: "evaluate" }),
    );

    res.status(201).json({
      job: insert.rows[0],
      expectedReportFilename,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Unable to queue evaluation",
    });
  }
});

app.post("/v1/scans", async (req, res) => {
  try {
    const config = await loadPortalsConfig();
    const scanPayload = {
      title_filter: config.title_filter || {},
      search_queries: Array.isArray(config.search_queries)
        ? config.search_queries.filter((item: any) => item.enabled !== false)
        : [],
      tracked_companies: Array.isArray(config.tracked_companies)
        ? config.tracked_companies.filter((item: any) => item.enabled !== false)
        : [],
    };

    const insert = await pool.query(
      `INSERT INTO jobs (type, status, payload) VALUES ($1, $2, $3) RETURNING *`,
      ["scan", "pending", scanPayload],
    );

    await redis.lpush(
      jobQueueKey,
      JSON.stringify({ jobId: insert.rows[0].id, type: "scan" }),
    );

    res.status(201).json({ job: insert.rows[0] });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to queue scan",
    });
  }
});

app.get("/v1/pipeline", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM pipeline_items ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch pipeline items",
    });
  }
});

app.post("/v1/pipeline", async (req, res) => {
  try {
    const { url, company, title, source } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Missing required field: url" });
    }
    const result = await pool.query(
      `INSERT INTO pipeline_items (url, company, title, source, status) VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (url) DO UPDATE SET company = COALESCE(EXCLUDED.company, pipeline_items.company), title = COALESCE(EXCLUDED.title, pipeline_items.title) RETURNING *`,
      [url, company || null, title || null, source || "manual"],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to create pipeline item",
    });
  }
});

app.post("/v1/pipeline/process", async (req, res) => {
  try {
    const insert = await pool.query(
      `INSERT INTO jobs (type, status, payload) VALUES ($1, $2, $3) RETURNING *`,
      ["pipeline_process", "pending", {}],
    );

    await redis.lpush(
      jobQueueKey,
      JSON.stringify({ jobId: insert.rows[0].id, type: "pipeline_process" }),
    );

    res.status(201).json({ job: insert.rows[0] });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to queue pipeline process",
    });
  }
});

app.get("/v1/scans", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM scan_runs ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Unable to fetch scan runs",
    });
  }
});

app.get("/v1/scans/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const runResult = await pool.query(
      `SELECT * FROM scan_runs WHERE id = $1`,
      [id],
    );
    if (runResult.rowCount === 0) {
      return res.status(404).json({ error: "Scan run not found" });
    }
    const results = await pool.query(
      `SELECT * FROM scan_results WHERE scan_run_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    res.json({ run: runResult.rows[0], results: results.rows });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Unable to fetch scan run",
    });
  }
});

app.get("/v1/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch job",
    });
  }
});

app.get("/v1/reports/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM reports WHERE id = $1`, [
      id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Report not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch report",
    });
  }
});

app.get("/v1/reports/job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await pool.query(`SELECT * FROM reports WHERE job_id = $1`, [
      jobId,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Report not found for job" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch report",
    });
  }
});

// Serve generated CV PDFs
app.get("/v1/output/:filename", async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(pdfOutputDir, filename);
    await fs.access(filePath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    const stream = await fs.readFile(filePath);
    res.send(stream);
  } catch {
    res.status(404).json({ error: "PDF not found" });
  }
});

app.delete("/v1/tracker/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM tracker WHERE id = $1 RETURNING id`,
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tracker entry not found" });
    }
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to delete entry",
    });
  }
});

app.patch("/v1/tracker/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const result = await pool.query(
      `UPDATE tracker SET status = COALESCE($1, status), notes = COALESCE($2, notes) WHERE id = $3 RETURNING *`,
      [status || null, notes || null, id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tracker entry not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to update entry",
    });
  }
});

const VALID_MODES = ["ofertas", "interview-prep", "contacto", "deep", "apply", "training", "project", "patterns"];

app.post("/v1/modes/:mode", async (req, res) => {
  try {
    const { mode } = req.params;
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: `Unknown mode: ${mode}. Valid modes: ${VALID_MODES.join(", ")}` });
    }

    const payload = { mode, ...req.body };
    const insert = await pool.query(
      `INSERT INTO jobs (type, status, payload) VALUES ($1, $2, $3) RETURNING *`,
      [mode, "pending", payload],
    );

    await redis.lpush(
      jobQueueKey,
      JSON.stringify({ jobId: insert.rows[0].id, type: mode }),
    );

    res.status(201).json({ job: insert.rows[0] });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to queue mode job",
    });
  }
});

app.get("/v1/modes/results/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await pool.query(
      `SELECT * FROM mode_results WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [jobId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No mode result found for this job" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch mode result",
    });
  }
});

app.get("/v1/modes/results", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT mr.*, j.type as mode_type FROM mode_results mr JOIN jobs j ON mr.job_id = j.id ORDER BY mr.created_at DESC LIMIT 50`,
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch mode results",
    });
  }
});

app.post("/v1/batch", async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "Missing required field: urls (array)" });
    }
    if (urls.length > 50) {
      return res.status(400).json({ error: "Maximum 50 URLs per batch" });
    }

    const jobIds: number[] = [];
    for (const url of urls) {
      if (typeof url !== "string" || !url.startsWith("http")) continue;
      // Add to pipeline_items; duplicates are silently ignored
      await pool.query(
        `INSERT INTO pipeline_items (url, source, status) VALUES ($1, 'batch', 'pending') ON CONFLICT (url) DO NOTHING`,
        [url],
      );
    }

    // Queue a pipeline_process job to pick them up
    const insert = await pool.query(
      `INSERT INTO jobs (type, status, payload) VALUES ($1, $2, $3) RETURNING *`,
      ["pipeline_process", "pending", { source: "batch", urlCount: urls.length }],
    );
    await redis.lpush(
      jobQueueKey,
      JSON.stringify({ jobId: insert.rows[0].id, type: "pipeline_process" }),
    );
    jobIds.push(insert.rows[0].id);

    res.status(201).json({ job: insert.rows[0], urlsQueued: urls.length });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to queue batch",
    });
  }
});

app.listen(port, async () => {
  try {
    await initDatabase();
    console.log(`[backend] connected to database and listening on ${port}`);
  } catch (error) {
    console.error("[backend] failed to initialize database", error);
    process.exit(1);
  }
});
