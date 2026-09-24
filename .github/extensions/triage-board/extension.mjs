import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();
let session;

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function repoFromRemote(remote) {
    const match = remote.trim().match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
    if (!match) throw new Error(`Could not determine a GitHub repository from remote: ${remote}`);
    return `${match[1]}/${match[2]}`;
}

function scoreIssue(issue) {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    const text = `${issue.title} ${issue.body ?? ""}`.toLowerCase();
    let score = 0;
    if (labels.some((label) => /bug|security|urgent|blocker|regression/.test(label))) score += 8;
    if (labels.some((label) => /help wanted|good first issue/.test(label))) score -= 1;
    if (/(broken|crash|fail|error|regression|security|urgent|blocker|data loss)/.test(text)) score += 4;
    score += Math.min(issue.comments, 5);
    score += Math.max(0, 3 - Math.floor((Date.now() - Date.parse(issue.updatedAt)) / 86_400_000));
    return score;
}

function rankReason(issue) {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    const reasons = [];
    if (labels.some((label) => /bug|security|urgent|blocker|regression/.test(label))) reasons.push("it carries a high-impact label");
    if (/(broken|crash|fail|error|regression|security|urgent|blocker|data loss)/i.test(`${issue.title} ${issue.body ?? ""}`)) reasons.push("the wording suggests active breakage or risk");
    if (issue.comments > 0) reasons.push(`${issue.comments} comment${issue.comments === 1 ? "" : "s"} indicate active discussion`);
    if (reasons.length === 0) reasons.push("it is among the most recently updated open issues");
    return `${reasons[0].charAt(0).toUpperCase()}${reasons[0].slice(1)}${reasons.length > 1 ? `; ${reasons.slice(1).join("; ")}` : ""}.`;
}

async function loadIssues() {
    const { stdout: remote } = await execFileAsync("git", ["config", "--get", "remote.origin.url"]);
    const repo = repoFromRemote(remote);
    const { stdout } = await execFileAsync("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,body,labels,updatedAt,comments"]);
    const issues = JSON.parse(stdout).map((issue) => {
        const normalized = { ...issue, labels: issue.labels ?? [], comments: issue.comments ?? 0, repo };
        return { ...normalized, score: scoreIssue(normalized) };
    });
    return issues.sort((a, b) => b.score - a.score || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function issueCard(issue, showReason) {
    const description = issue.body?.trim() || "No description was provided.";
    return `<article class="card" data-testid="issue-card-${issue.number}">
  <div class="card-heading"><span class="issue-number">#${issue.number}</span><h3>${escapeHtml(issue.title)}</h3></div>
  <p class="description">${escapeHtml(description)}</p>
  <div class="meta">${issue.labels.map((label) => `<span class="label">${escapeHtml(label.name)}</span>`).join("")}<span>Updated ${escapeHtml(new Date(issue.updatedAt).toLocaleDateString())}</span></div>
  ${showReason ? `<p class="reason"><strong>Why it’s here:</strong> ${escapeHtml(rankReason(issue))}</p>` : ""}
  <button class="add-button" data-testid="add-issue-${issue.number}" data-repo="${escapeHtml(issue.repo)}" data-number="${issue.number}" data-title="${escapeHtml(issue.title)}">Add to current context</button>
</article>`;
}

function renderHtml(issues, error) {
    const top = issues.slice(0, 3);
    const remainder = issues.slice(3);
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Issue triage</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font:14px/1.5 var(--font-sans,system-ui,sans-serif)}h1,h2,h3,p{margin:0}h1{font-size:24px}h2{font-size:17px;margin-bottom:12px}h3{font-size:15px}header{display:flex;justify-content:space-between;gap:16px;margin-bottom:24px}header p{color:var(--text-color-muted,#656d76);margin-top:4px}section{margin-bottom:28px}.board{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.card{border:1px solid var(--border-color-default,#d0d7de);border-radius:10px;padding:16px;background:var(--background-color-default,#fff);display:flex;flex-direction:column;gap:12px}.priority .card{border-color:var(--true-color-orange,#d1242f)}.card-heading{display:flex;gap:8px;align-items:baseline}.issue-number{color:var(--text-color-muted,#656d76);font-variant-numeric:tabular-nums}.description{color:var(--text-color-muted,#656d76);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:var(--text-color-muted,#656d76);font-size:12px}.label{border:1px solid var(--border-color-default,#d0d7de);border-radius:999px;padding:1px 7px}.reason{padding:10px;border-radius:6px;background:var(--background-color-muted,rgba(127,127,127,.12));font-size:13px}.add-button{margin-top:auto;border:0;border-radius:6px;padding:8px 12px;background:var(--true-color-blue,#0969da);color:var(--color-white,#fff);cursor:pointer;font-weight:600}.add-button:focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:2px}.add-button:disabled{opacity:.65;cursor:wait}.empty,.error{padding:16px;border:1px dashed var(--border-color-default,#d0d7de);border-radius:8px;color:var(--text-color-muted,#656d76)}.error{color:var(--true-color-red,#d1242f)}@media(max-width:600px){body{padding:16px}header{display:block}}
</style></head><body>
<header><div><h1>Issue triage</h1><p>Prioritized open issues for ${escapeHtml(issues[0]?.repo ?? "this repository")}.</p></div><small>Live snapshot</small></header>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<section class="priority"><h2>Needs attention now</h2><div class="board">${top.length ? top.map((issue) => issueCard(issue, true)).join("") : `<p class="empty">No open issues found.</p>`}</div></section>
<section><h2>Remaining open issues</h2><div class="board">${remainder.length ? remainder.map((issue) => issueCard(issue, false)).join("") : `<p class="empty">Everything is in the priority lane.</p>`}</div></section>
<script>
document.querySelectorAll(".add-button").forEach((button)=>button.addEventListener("click",async()=>{button.disabled=true;button.textContent="Adding…";try{const response=await fetch("/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repo:button.dataset.repo,number:Number(button.dataset.number),title:button.dataset.title})});if(!response.ok)throw new Error(await response.text());button.textContent="Added to context"}catch(error){button.disabled=false;button.textContent="Try again";window.alert(error.message)}}));
</script></body></html>`;
}

async function addIssueToContext(issue) {
    if (!issue || !issue.repo || !Number.isInteger(issue.number) || !issue.title) throw new Error("Issue number, title, and repository are required.");
    await session.send({ prompt: `Add GitHub issue ${issue.repo}#${issue.number} to the current work context. Issue title: ${issue.title}. Inspect the issue and begin by proposing the smallest complete implementation plan.` });
    return { added: true, issue: `${issue.repo}#${issue.number}` };
}

async function startServer() {
    let issues = [];
    let error = "";
    try {
        issues = await loadIssues();
    } catch (cause) {
        error = `Unable to load open issues: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    const server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/add") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", async () => {
                try {
                    const result = await addIssueToContext(JSON.parse(body));
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                } catch (cause) {
                    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                    res.end(cause instanceof Error ? cause.message : String(cause));
                }
            });
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml(issues, error));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/` };
}

session = await joinSession({
    canvases: [createCanvas({
        id: "triage-board",
        displayName: "Issue triage board",
        description: "A Kanban board that ranks open GitHub issues and adds selected issues to the current session context.",
        actions: [{
            name: "add_issue_to_context",
            description: "Add a GitHub issue to the current session context and start a focused implementation plan.",
            inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" }, title: { type: "string" } }, required: ["repo", "number", "title"], additionalProperties: false },
            handler: async (ctx) => addIssueToContext(ctx.input),
        }],
        open: async (ctx) => {
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await startServer();
                servers.set(ctx.instanceId, entry);
            }
            return { title: "Issue triage board", url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(() => resolve()));
            }
        },
    })],
});
