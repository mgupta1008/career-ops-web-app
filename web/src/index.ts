import http from "node:http";

const port = Number(process.env.PORT || 3000);
const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001";

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Full App Web</title>
    <style>
      body { font-family: ui-sans-serif, system-ui; padding: 24px; background: #fafafa; color: #111827; }
      .card { background: #ffffff; padding: 18px; border-radius: 18px; margin-bottom: 24px; box-shadow: 0 12px 30px rgba(15,23,42,0.06); }
      .card h2 { margin-top: 0; }
      .card h3 { margin: 0 0 12px; }
      .experience-item { margin-bottom: 18px; }
      .experience-item strong { display: block; font-size: 1rem; margin-bottom: 6px; }
      .summary { margin-bottom: 16px; }
      .skills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .skill-pill { background: #e2e8f0; border-radius: 9999px; padding: 6px 12px; font-size: 0.95rem; }
      dt { font-weight: 700; }
      dd { margin: 0 0 8px 0; }
      label { display: block; margin-top: 12px; font-weight: 600; }
      input, textarea { width: 100%; padding: 10px 12px; margin-top: 6px; border: 1px solid #cbd5e1; border-radius: 12px; background: #f8fafc; }
      button { margin-top: 16px; padding: 12px 18px; border: none; border-radius: 9999px; background: #2563eb; color: white; cursor: pointer; }
      button:hover { background: #1d4ed8; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; }
      tbody tr:hover { background: #f8fafc; }
      #error { color: #b91c1c; margin-bottom: 16px; }
      #eval-result { margin-top: 12px; color: #1f2937; }
    </style>
  </head>
  <body>
    <h1>Full App Web</h1>
    <p>API base: <code>${apiBase}</code></p>
    <div id="error"></div>
    <div id="profile" class="card">Loading profile...</div>
    <div id="cv" class="card">Loading CV...</div>
    <div id="evaluation" class="card">Loading evaluation form...</div>
    <div id="scan" class="card">Loading scan controls...</div>
    <div id="scans" class="card">Loading scan runs...</div>
    <div id="pipeline" class="card">Loading pipeline...</div>
    <div id="tracker" class="card">Loading tracker...</div>
    <div id="modes" class="card">Loading modes...</div>
    <div id="batch" class="card">Loading batch...</div>
    <div id="mode-results" class="card">Loading mode results...</div>
    <div id="jobs" class="card">Loading jobs...</div>
    <div id="reports" class="card">Loading reports...</div>
    <script>
      const apiBase = ${JSON.stringify(apiBase)};

      async function fetchJson(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
          const body = await response.text();
          throw new Error('Request failed ' + response.status + ': ' + body);
        }
        return response.json();
      }

      function renderProfile(profile) {
        return (
          '<h2>Profile</h2>' +
          '<dl>' +
          '<dt>Name</dt><dd>' + (profile?.candidate?.full_name || 'N/A') + '</dd>' +
          '<dt>Email</dt><dd>' + (profile?.candidate?.email || 'N/A') + '</dd>' +
          '<dt>Location</dt><dd>' + (profile?.candidate?.location || 'N/A') + '</dd>' +
          '<dt>Primary target roles</dt><dd>' + ((profile?.target_roles?.primary || []).join(', ') || 'N/A') + '</dd>' +
          '</dl>'
        );
      }

      function renderCv(cv) {
        const experienceHtml = (cv.parsed.experience || [])
          .map(function (item) {
            return (
              '<div class="experience-item">' +
              '<strong>' + item.company + ' — ' + item.role + '</strong>' +
              '<ul>' +
              (item.bullets || []).map(function (bullet) {
                return '<li>' + bullet + '</li>';
              }).join('') +
              '</ul>' +
              '</div>'
            );
          })
          .join('');

        const skillsHtml = (cv.parsed.skills || [])
          .map(function (skill) {
            return '<span class="skill-pill">' + skill + '</span>';
          })
          .join('');

        return (
          '<h2>CV</h2>' +
          '<div class="summary">' + (cv.parsed.summary || '') + '</div>' +
          '<div><h3>Experience</h3>' + experienceHtml + '</div>' +
          '<div><h3>Skills</h3><div class="skills">' + skillsHtml + '</div></div>'
        );
      }

      function renderEvaluationForm() {
        return (
          '<h2>Submit Evaluation</h2>' +
          '<form id="eval-form">' +
          '<label>URL</label>' +
          '<input id="eval-url" type="text" placeholder="Job URL" required />' +
          '<label>Company</label>' +
          '<input id="eval-company" type="text" placeholder="Company name" />' +
          '<label>Role</label>' +
          '<input id="eval-role" type="text" placeholder="Job title" />' +
          '<label>Job description</label>' +
          '<textarea id="eval-text" rows="8" placeholder="Paste the JD text here" required></textarea>' +
          '<button type="submit">Queue evaluation</button>' +
          '</form>' +
          '<div id="eval-result"></div>'
        );
      }

      function renderTracker(entries) {
        if (!entries || entries.length === 0) {
          return '<h2>Application Tracker</h2><p>No applications tracked yet.</p>';
        }
        return (
          '<h2>Application Tracker</h2>' +
          '<table><thead><tr><th>Company</th><th>Role</th><th>Score</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>' +
          '<tbody>' +
          entries.map(function (entry) {
            var scoreColor = entry.score >= 4.5 ? '#15803d' : entry.score >= 4 ? '#1d4ed8' : entry.score >= 3.5 ? '#b45309' : '#b91c1c';
            return (
              '<tr id="tracker-row-' + entry.id + '">' +
              '<td>' + (entry.company || 'N/A') + '</td>' +
              '<td>' + (entry.role || 'N/A') + '</td>' +
              '<td style="color:' + scoreColor + ';font-weight:600;">' + (entry.score ? Number(entry.score).toFixed(1) + '/5' : 'N/A') + '</td>' +
              '<td>' +
              '<select onchange="updateTrackerStatus(' + entry.id + ', this.value)" style="border:1px solid #cbd5e1;border-radius:6px;padding:4px 6px;font-size:0.85rem;">' +
              ['Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP'].map(function(s) {
                return '<option value="' + s + '"' + (entry.status === s ? ' selected' : '') + '>' + s + '</option>';
              }).join('') +
              '</select>' +
              '</td>' +
              '<td style="max-width:200px;white-space:pre-wrap;font-size:0.85rem;">' + escapeHtml(entry.notes || '') + '</td>' +
              '<td><button onclick="deleteTrackerEntry(' + entry.id + ')" style="padding:4px 10px;border:none;border-radius:6px;background:#fee2e2;color:#b91c1c;cursor:pointer;font-size:0.85rem;">Delete</button></td>' +
              '</tr>'
            );
          }).join('') +
          '</tbody></table>'
        );
      }

      async function updateTrackerStatus(id, status) {
        try {
          await fetchJson(apiBase + '/v1/tracker/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          });
        } catch (err) {
          document.getElementById('error').textContent = err.message;
        }
      }

      async function deleteTrackerEntry(id) {
        if (!confirm('Delete this tracker entry?')) return;
        try {
          await fetchJson(apiBase + '/v1/tracker/' + id, { method: 'DELETE' });
          var row = document.getElementById('tracker-row-' + id);
          if (row) row.remove();
        } catch (err) {
          document.getElementById('error').textContent = err.message;
        }
      }

      function renderJobs(jobs) {
        if (!jobs || jobs.length === 0) {
          return '<h2>Jobs</h2><p>No jobs queued yet.</p>';
        }
        return (
          '<h2>Jobs</h2>' +
          '<table><thead><tr><th>ID</th><th>Status</th><th>Company</th><th>Role</th><th>Created</th></tr></thead>' +
          '<tbody>' +
          jobs.map(function (job) {
            const payload = job.payload || {};
            return (
              '<tr>' +
              '<td>' + job.id + '</td>' +
              '<td>' + job.status + '</td>' +
              '<td>' + (payload.company || 'N/A') + '</td>' +
              '<td>' + (payload.role || 'N/A') + '</td>' +
              '<td>' + new Date(job.created_at).toLocaleString() + '</td>' +
              '</tr>'
            );
          }).join('') +
          '</tbody></table>'
        );
      }

      function renderReports(reports) {
        if (!reports || reports.length === 0) {
          return '<h2>Reports</h2><p>No reports yet.</p>';
        }
        return (
          '<h2>Reports</h2>' +
          reports.map(function (report) {
            var pdfLink = report.pdf_path
              ? '<a href="' + apiBase + '/v1/output/' + encodeURIComponent(report.pdf_path) + '" target="_blank" style="margin-left:8px;padding:4px 10px;background:#2563eb;color:#fff;border-radius:6px;font-size:0.85rem;text-decoration:none;">Download PDF</a>'
              : '';
            return (
              '<div class="card" style="margin-bottom:16px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
              '<strong>' + (report.title || 'Evaluation Report') + '</strong>' +
              '<span style="color:#777;font-size:0.85rem;">' + new Date(report.created_at).toLocaleString() + pdfLink + '</span>' +
              '</div>' +
              '<details><summary style="cursor:pointer;color:#2563eb;">View full report</summary>' +
              '<pre style="white-space:pre-wrap;word-break:break-word;font-size:0.82rem;margin-top:8px;background:#f8fafc;padding:12px;border-radius:8px;overflow-x:auto;">' + escapeHtml(report.body || '') + '</pre>' +
              '</details>' +
              '</div>'
            );
          }).join('')
        );
      }

      function escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }

      function renderScanForm() {
        return (
          '<h2>Run Portal Scan</h2>' +
          '<p>Scan configured portals and search queries from <code>backend/portals.yml</code>.</p>' +
          '<button id="scan-button" type="button">Start scan</button>' +
          '<div id="scan-result"></div>'
        );
      }

      function renderScans(scans) {
        if (!scans || scans.length === 0) {
          return '<h2>Scan Runs</h2><p>No scans run yet.</p>';
        }
        return (
          '<h2>Scan Runs</h2>' +
          '<table><thead><tr><th>ID</th><th>Status</th><th>Queries</th><th>Results</th><th>Matched</th><th>Created</th></tr></thead>' +
          '<tbody>' +
          scans.map(function (scan) {
            return (
              '<tr>' +
              '<td>' + scan.id + '</td>' +
              '<td>' + scan.status + '</td>' +
              '<td>' + scan.query_count + '</td>' +
              '<td>' + scan.result_count + '</td>' +
              '<td>' + scan.matched_count + '</td>' +
              '<td>' + new Date(scan.created_at).toLocaleString() + '</td>' +
              '</tr>'
            );
          }).join('') +
          '</tbody></table>'
        );
      }

      function renderPipelineSection(items) {
        return (
          '<h2>Pipeline Inbox</h2>' +
          '<form id="pipeline-form">' +
          '<label>Job URL</label>' +
          '<input id="pipeline-url" type="text" placeholder="Job URL" required />' +
          '<label>Company</label>' +
          '<input id="pipeline-company" type="text" placeholder="Company name" />' +
          '<label>Title</label>' +
          '<input id="pipeline-title" type="text" placeholder="Job title" />' +
          '<label>Source</label>' +
          '<input id="pipeline-source" type="text" placeholder="Source (e.g. scan, manual)" />' +
          '<button type="submit">Add to pipeline</button>' +
          '</form>' +
          '<button id="pipeline-process-button" type="button">Process pending pipeline items</button>' +
          '<div id="pipeline-result"></div>' +
          renderPipelineItems(items)
        );
      }

      function renderPipelineItems(items) {
        if (!items || items.length === 0) {
          return '<h3>Pipeline Items</h3><p>No pending pipeline items.</p>';
        }

        return (
          '<h3>Pipeline Items</h3>' +
          '<table><thead><tr><th>ID</th><th>Status</th><th>Company</th><th>Title</th><th>Source</th><th>Created</th></tr></thead>' +
          '<tbody>' +
          items.map(function (item) {
            return (
              '<tr>' +
              '<td>' + item.id + '</td>' +
              '<td>' + item.status + '</td>' +
              '<td>' + (item.company || 'N/A') + '</td>' +
              '<td>' + (item.title || 'N/A') + '</td>' +
              '<td>' + (item.source || 'N/A') + '</td>' +
              '<td>' + new Date(item.created_at).toLocaleString() + '</td>' +
              '</tr>'
            );
          }).join('') +
          '</tbody></table>'
        );
      }

      var MODE_FIELDS = {
        ofertas: [{ id: 'offers', label: 'Offers to compare', type: 'textarea', placeholder: 'Paste each offer description or URL (one per section)' }],
        'interview-prep': [
          { id: 'company', label: 'Company', type: 'input', placeholder: 'Company name' },
          { id: 'role', label: 'Role', type: 'input', placeholder: 'Job title' },
        ],
        contacto: [
          { id: 'company', label: 'Company', type: 'input', placeholder: 'Company name' },
          { id: 'role', label: 'Role', type: 'input', placeholder: 'Job title' },
          { id: 'description', label: 'Job description', type: 'textarea', placeholder: 'Paste the JD text' },
        ],
        deep: [
          { id: 'company', label: 'Company', type: 'input', placeholder: 'Company name' },
          { id: 'role', label: 'Role', type: 'input', placeholder: 'Job title' },
        ],
        apply: [
          { id: 'company', label: 'Company', type: 'input', placeholder: 'Company name' },
          { id: 'role', label: 'Role', type: 'input', placeholder: 'Job title' },
          { id: 'questions', label: 'Form questions', type: 'textarea', placeholder: 'Paste the application form questions here' },
        ],
        training: [
          { id: 'course', label: 'Course / Certification', type: 'input', placeholder: 'Course name and provider' },
          { id: 'description', label: 'Description', type: 'textarea', placeholder: 'Brief description of the course' },
        ],
        project: [{ id: 'description', label: 'Project idea', type: 'textarea', placeholder: 'Describe the portfolio project you are considering' }],
        patterns: [],
      };

      function renderModesSection() {
        return (
          '<h2>AI Modes</h2>' +
          '<p>Run a career-ops mode against your CV and profile using Claude AI.</p>' +
          '<form id="mode-form">' +
          '<label>Mode</label>' +
          '<select id="mode-select" onchange="renderModeFields()" style="width:100%;padding:10px 12px;margin-top:6px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc;">' +
          Object.keys(MODE_FIELDS).map(function(m) { return '<option value="' + m + '">' + m + '</option>'; }).join('') +
          '</select>' +
          '<div id="mode-dynamic-fields"></div>' +
          '<button type="submit">Run mode</button>' +
          '</form>' +
          '<div id="mode-result" style="margin-top:12px;"></div>'
        );
      }

      function renderModeFields() {
        var mode = document.getElementById('mode-select').value;
        var fields = MODE_FIELDS[mode] || [];
        var html = fields.length === 0
          ? '<p style="margin-top:12px;color:#555;">No input required — reads from your tracker data.</p>'
          : fields.map(function(f) {
              return '<label>' + f.label + '</label>' +
                (f.type === 'textarea'
                  ? '<textarea id="mode-field-' + f.id + '" rows="5" placeholder="' + f.placeholder + '"></textarea>'
                  : '<input id="mode-field-' + f.id + '" type="text" placeholder="' + f.placeholder + '" />');
            }).join('');
        document.getElementById('mode-dynamic-fields').innerHTML = html;
      }

      function renderBatchSection() {
        return (
          '<h2>Batch URL Submission</h2>' +
          '<p>Add multiple job URLs at once. Each URL will be added to the pipeline and processed in one job.</p>' +
          '<form id="batch-form">' +
          '<label>Job URLs (one per line)</label>' +
          '<textarea id="batch-urls" rows="6" placeholder="One URL per line"></textarea>' +
          '<button type="submit">Submit batch</button>' +
          '</form>' +
          '<div id="batch-result" style="margin-top:12px;"></div>'
        );
      }

      function renderModeResults(results) {
        if (!results || results.length === 0) {
          return '<h2>Mode Results</h2><p>No mode results yet.</p>';
        }
        return (
          '<h2>Mode Results</h2>' +
          results.map(function(r) {
            return (
              '<div class="card" style="margin-bottom:16px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
              '<strong>' + r.mode_type + '</strong>' +
              '<span style="color:#777;font-size:0.85rem;">' + new Date(r.created_at).toLocaleString() + '</span>' +
              '</div>' +
              '<details><summary style="cursor:pointer;color:#2563eb;">View result</summary>' +
              '<pre style="white-space:pre-wrap;word-break:break-word;font-size:0.82rem;margin-top:8px;background:#f8fafc;padding:12px;border-radius:8px;overflow-x:auto;">' + escapeHtml(r.result || '') + '</pre>' +
              '</details>' +
              '</div>'
            );
          }).join('')
        );
      }

      async function loadData() {
        const [profileRes, cvRes, jobsRes, reportsRes, scansRes, pipelineRes, trackerRes, modeResultsRes] = await Promise.all([
          fetch(apiBase + '/v1/profile'),
          fetch(apiBase + '/v1/cv'),
          fetch(apiBase + '/v1/jobs'),
          fetch(apiBase + '/v1/reports'),
          fetch(apiBase + '/v1/scans'),
          fetch(apiBase + '/v1/pipeline'),
          fetch(apiBase + '/v1/tracker'),
          fetch(apiBase + '/v1/modes/results'),
        ]);

        if (!profileRes.ok || !cvRes.ok || !jobsRes.ok || !reportsRes.ok || !scansRes.ok || !pipelineRes.ok || !trackerRes.ok) {
          throw new Error("Failed to load API data");
        }

        const profile = await profileRes.json();
        const cv = await cvRes.json();
        const jobs = await jobsRes.json();
        const reports = await reportsRes.json();
        const scans = await scansRes.json();
        const pipeline = await pipelineRes.json();
        const tracker = await trackerRes.json();
        const modeResults = modeResultsRes.ok ? await modeResultsRes.json() : [];

        document.getElementById('profile').innerHTML = renderProfile(profile);
        document.getElementById('cv').innerHTML = renderCv(cv);
        document.getElementById('evaluation').innerHTML = renderEvaluationForm();
        document.getElementById('scan').innerHTML = renderScanForm();
        document.getElementById('scans').innerHTML = renderScans(scans);
        document.getElementById('pipeline').innerHTML = renderPipelineSection(pipeline);
        document.getElementById('tracker').innerHTML = renderTracker(tracker);
        document.getElementById('modes').innerHTML = renderModesSection();
        document.getElementById('batch').innerHTML = renderBatchSection();
        document.getElementById('mode-results').innerHTML = renderModeResults(modeResults);
        document.getElementById('jobs').innerHTML = renderJobs(jobs);
        document.getElementById('reports').innerHTML = renderReports(reports);

        // Initial mode fields render
        renderModeFields();

        document.getElementById('mode-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          var mode = document.getElementById('mode-select').value;
          var fields = MODE_FIELDS[mode] || [];
          var payload = {};
          fields.forEach(function(f) {
            var el = document.getElementById('mode-field-' + f.id);
            if (el) payload[f.id] = el.value.trim();
          });
          var result = document.getElementById('mode-result');
          result.textContent = 'Running mode ' + mode + '...';
          try {
            var json = await fetchJson(apiBase + '/v1/modes/' + mode, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            result.innerHTML = '<strong>Queued job ' + json.job.id + '</strong> — mode: ' + mode + '. Results will appear below once complete.';
          } catch (err) {
            result.textContent = err.message;
          }
        });

        document.getElementById('batch-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          var raw = document.getElementById('batch-urls').value.trim();
          var urls = raw.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.startsWith('http'); });
          var result = document.getElementById('batch-result');
          if (urls.length === 0) { result.textContent = 'No valid URLs found.'; return; }
          result.textContent = 'Submitting ' + urls.length + ' URL(s)...';
          try {
            var json = await fetchJson(apiBase + '/v1/batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ urls }),
            });
            result.innerHTML = '<strong>Batch queued — ' + json.urlsQueued + ' URL(s), job ' + json.job.id + '</strong>';
            await loadPipeline();
          } catch (err) {
            result.textContent = err.message;
          }
        });

        document.getElementById('eval-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          const url = document.getElementById('eval-url').value.trim();
          const company = document.getElementById('eval-company').value.trim();
          const role = document.getElementById('eval-role').value.trim();
          const text = document.getElementById('eval-text').value.trim();
          const result = document.getElementById('eval-result');
          result.textContent = 'Submitting evaluation...';

          try {
            const json = await fetchJson(apiBase + '/v1/evaluate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, company, role, text }),
            });
            result.innerHTML = '<strong>Queued job ' + json.job.id + '</strong><br/>Expected report file: ' + json.expectedReportFilename;
            loadJobsAndReports();
          } catch (err) {
            result.textContent = err.message;
          }
        });

        document.getElementById('scan-button').addEventListener('click', async function () {
          const result = document.getElementById('scan-result');
          result.textContent = 'Starting portal scan...';
          try {
            const json = await fetchJson(apiBase + '/v1/scans', {
              method: 'POST',
            });
            result.innerHTML = '<strong>Scan queued, job ' + json.job.id + '</strong>';
            await loadScans();
          } catch (err) {
            result.textContent = err.message;
          }
        });

        const pipelineForm = document.getElementById('pipeline-form');
        if (pipelineForm) {
          pipelineForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            const result = document.getElementById('pipeline-result');
            result.textContent = 'Adding pipeline item...';
            try {
              const url = document.getElementById('pipeline-url').value.trim();
              const company = document.getElementById('pipeline-company').value.trim();
              const title = document.getElementById('pipeline-title').value.trim();
              const source = document.getElementById('pipeline-source').value.trim() || 'manual';
              await fetchJson(apiBase + '/v1/pipeline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, company, title, source }),
              });
              result.innerHTML = '<strong>Pipeline item added</strong>';
              await loadPipeline();
            } catch (err) {
              result.textContent = err.message;
            }
          });
        }

        const pipelineProcessButton = document.getElementById('pipeline-process-button');
        if (pipelineProcessButton) {
          pipelineProcessButton.addEventListener('click', async function () {
            const result = document.getElementById('pipeline-result');
            result.textContent = 'Queuing pipeline process...';
            try {
              const json = await fetchJson(apiBase + '/v1/pipeline/process', {
                method: 'POST',
              });
              result.innerHTML = '<strong>Pipeline processing queued, job ' + json.job.id + '</strong>';
              await loadPipeline();
            } catch (err) {
              result.textContent = err.message;
            }
          });
        }
      }

      async function loadScans() {
        try {
          const scans = await fetchJson(apiBase + '/v1/scans');
          document.getElementById('scans').innerHTML = renderScans(scans);
        } catch (err) {
          document.getElementById('scans').innerHTML = '<h2>Scan Runs</h2><p>Unable to load scan runs.</p>';
          document.getElementById('error').textContent = err.message;
        }
      }

      async function loadPipeline() {
        try {
          const pipeline = await fetchJson(apiBase + '/v1/pipeline');
          document.getElementById('pipeline').innerHTML = renderPipelineSection(pipeline);
          const pipelineForm = document.getElementById('pipeline-form');
          if (pipelineForm) {
            pipelineForm.addEventListener('submit', async function (event) {
              event.preventDefault();
              const result = document.getElementById('pipeline-result');
              result.textContent = 'Adding pipeline item...';
              try {
                const url = document.getElementById('pipeline-url').value.trim();
                const company = document.getElementById('pipeline-company').value.trim();
                const title = document.getElementById('pipeline-title').value.trim();
                const source = document.getElementById('pipeline-source').value.trim() || 'manual';
                await fetchJson(apiBase + '/v1/pipeline', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url, company, title, source }),
                });
                result.innerHTML = '<strong>Pipeline item added</strong>';
                await loadPipeline();
              } catch (err) {
                result.textContent = err.message;
              }
            });
          }

          const pipelineProcessButton = document.getElementById('pipeline-process-button');
          if (pipelineProcessButton) {
            pipelineProcessButton.addEventListener('click', async function () {
              const result = document.getElementById('pipeline-result');
              result.textContent = 'Queuing pipeline process...';
              try {
                const json = await fetchJson(apiBase + '/v1/pipeline/process', {
                  method: 'POST',
                });
                result.innerHTML = '<strong>Pipeline processing queued, job ' + json.job.id + '</strong>';
                await loadPipeline();
              } catch (err) {
                result.textContent = err.message;
              }
            });
          }
        } catch (err) {
          document.getElementById('pipeline').innerHTML = '<h2>Pipeline Inbox</h2><p>Unable to load pipeline items.</p>';
          document.getElementById('error').textContent = err.message;
        }
      }

      async function loadJobsAndReports() {
        try {
          const [jobs, reports, tracker, modeResults] = await Promise.all([
            fetchJson(apiBase + '/v1/jobs'),
            fetchJson(apiBase + '/v1/reports'),
            fetchJson(apiBase + '/v1/tracker'),
            fetch(apiBase + '/v1/modes/results').then(function(r) { return r.ok ? r.json() : []; }),
          ]);
          document.getElementById('jobs').innerHTML = renderJobs(jobs);
          document.getElementById('reports').innerHTML = renderReports(reports);
          document.getElementById('tracker').innerHTML = renderTracker(tracker);
          document.getElementById('mode-results').innerHTML = renderModeResults(modeResults);
          await loadScans();
          await loadPipeline();
        } catch (err) {
          document.getElementById('error').textContent = err.message;
        }
      }

      loadData().catch(function (err) {
        document.getElementById('error').textContent = err.message;
      });
    </script>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "web" }));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[web] listening on ${port}`);
});
