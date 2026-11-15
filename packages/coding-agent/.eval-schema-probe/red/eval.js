// @bun
// packages/coding-agent/src/tools/shell/eval.ts
import { type } from "@veyyon/ai/utils/schema/arktype";
import { toolSchema } from "@veyyon/ai/utils/schema/tool-schema";
import { errorMessage, formatCount, lazy, logger, prompt } from "@veyyon/utils";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../../eval/bridge-timeout";
import { IdleTimeout } from "../../eval/idle-timeout";
import { defaultEvalSessionId } from "../../eval/session-id";
import { upsertStatusEvent } from "../../eval/status-events";
import { formatExitCodeNotice } from "../../exec/exit-notice";
import { toolsPrompts } from "../../prompts/tools/rows";
import {
  DEFAULT_MAX_BYTES,
  LIVE_OUTPUT_INTERVAL_MS,
  OutputSink,
  TailBuffer
} from "../../session/streaming-output";
import { resolveEnabledAgents } from "../../task/agent-settings";
import { discoverAgents } from "../../task/discovery";
import { resolveSpawnPolicy } from "../../task/spawn-policy";
import { webpExclusionForModel } from "../../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize";
import { truncateForPrompt } from "../core/approval";
import { inlineBudgetFor } from "../core/output-artifact";
import { foldToolOutputBookkeeping } from "../core/output-fold";
import {
  formatArtifactErrorNotice,
  resolveOutputMaxColumns,
  resolveOutputSinkArtifactMaxBytes
} from "../core/output-meta";
import { ToolAbortError, ToolError } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice, TOOL_TIMEOUTS } from "../core/tool-timeouts";
import { resolveEvalBackends } from "./eval-backends";
import { EVAL_DISPLAY_VERSION, formatDisplayJson } from "./eval-display";
import { evalToolView } from "./eval-view";
import { evalBackendLoaders } from "./manifest";
var EVAL_LANGUAGE_ORDER = ["py", "js", "rb", "jl"];
var EVAL_LANGUAGE_RUNTIME = {
  py: '"py" for the IPython kernel',
  js: '"js" for the persistent JS VM',
  rb: '"rb" for the persistent Ruby kernel',
  jl: '"jl" for the persistent Julia kernel'
};
var EVAL_LANGUAGE_NAME = {
  py: "Python",
  js: "JavaScript",
  rb: "Ruby",
  jl: "Julia"
};
function joinWithOr(items) {
  if (items.length <= 1)
    return items[0] ?? "";
  if (items.length === 2)
    return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
function describeLanguageField(langs) {
  return `runtime: ${langs.map((lang) => EVAL_LANGUAGE_RUNTIME[lang]).join(", ")}`;
}
function describeCodeField(langs) {
  const replLangs = langs.filter((lang) => lang === "rb" || lang === "jl");
  if (replLangs.length === 0)
    return "code to run in this eval call, verbatim. Use top-level await freely.";
  const awaitLangs = langs.filter((lang) => lang === "py" || lang === "js");
  const clauses = [];
  if (awaitLangs.length > 0)
    clauses.push(`Top-level \`await\` is available in ${awaitLangs.join("/")}`);
  clauses.push(`${replLangs.join("/")} auto-display the last expression like a REPL`);
  return `code to run in this eval call, verbatim. ${clauses.join("; ")}.`;
}
function summarizeEvalLanguages(langs) {
  const names = langs.map((lang) => EVAL_LANGUAGE_NAME[lang]);
  const list = names.length > 0 ? joinWithOr(names) : "Python or JavaScript";
  const backend = langs.some((lang) => lang === "rb" || lang === "jl") ? "a persistent" : "an in-process";
  return `Execute ${list} code in ${backend} eval backend`;
}
function enabledEvalLanguages(backends) {
  const allowed = {
    py: backends.python,
    js: backends.js,
    rb: backends.ruby,
    jl: backends.julia
  };
  return EVAL_LANGUAGE_ORDER.filter((lang) => allowed[lang]);
}
var evalCellCommonFields = lazy(() => ({
  "title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
  "timeout?": type("number").describe(describeTimeoutParam("eval", { zeroDisablesNoun: "cell timeout" })),
  "reset?": type("boolean").describe("wipe this language's kernel before running. Other languages are untouched.")
}));
var evalSchema = toolSchema("eval", () => type({
  language: type("'py' | 'js' | 'rb' | 'jl'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
  ...evalCellCommonFields.value,
  code: type("string").describe(describeCodeField(EVAL_LANGUAGE_ORDER))
}));
var evalSchemaByLanguages = new Map;
function evalSchemaFor(langs) {
  if (langs.length === 0 || langs.length === EVAL_LANGUAGE_ORDER.length)
    return evalSchema;
  const key = langs.join(",");
  let schema = evalSchemaByLanguages.get(key);
  if (schema === undefined) {
    schema = toolSchema(`eval:${key}`, () => type({
      language: type.enumerated(...langs).describe(describeLanguageField(langs)),
      code: type("string").describe(describeCodeField(langs)),
      ...evalCellCommonFields.value
    }));
    evalSchemaByLanguages.set(key, schema);
  }
  return schema;
}
function getEvalToolDescription(options = {}) {
  const py = options.py ?? true;
  const js = options.js ?? true;
  const rb = options.rb ?? false;
  const jl = options.jl ?? false;
  const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
  const hasEffectiveCatalog = options.effectiveAgents !== undefined;
  const effectiveAgents = options.effectiveAgents ?? [];
  const spawns = hasEffectiveCatalog ? effectiveAgents.length > 0 : spawnPolicy.enabled;
  const spawnDefaultAgent = hasEffectiveCatalog ? options.effectiveDefaultAgent : spawnPolicy.defaultAgent;
  const spawnAllowedAgentsText = hasEffectiveCatalog ? effectiveAgents.map((agent) => `\`${agent}\``).join(", ") : spawnPolicy.allowedPromptText;
  const pyWorkspace = (options.pyWorkspace ?? false) && py;
  return prompt.render(toolsPrompts["tools/eval"].text, {
    py,
    js,
    rb,
    jl,
    spawns,
    spawnDefaultAgent,
    hasSpawnDefaultAgent: spawnDefaultAgent !== undefined,
    spawnAllowedAgentsText,
    spawnAgentListLabel: hasEffectiveCatalog ? "Enabled agents" : "Allowed agents",
    pyWorkspace
  });
}
function describeEvalCell(cell) {
  return cell.title ?? `the ${cell.resolved.backend.id} cell`;
}
function timeoutClampNotice(cell, maxTimeout) {
  if (cell.timeoutMs === 0)
    return;
  return formatTimeoutClampNotice("eval", cell.timeoutMs / 1000, clampTimeout("eval", cell.timeoutMs / 1000, maxTimeout));
}
function detailsNotice(cell, maxTimeout) {
  const notices = [
    ...new Set([cell.resolved.notice, timeoutClampNotice(cell, maxTimeout)].filter(Boolean))
  ];
  return notices.length > 0 ? notices.join(" ") : undefined;
}
async function resolveBackend(session, language, probeOptions) {
  const backends = resolveEvalBackends(session);
  const allowPy = backends.python;
  const allowJs = backends.js;
  const allowRb = backends.ruby;
  const allowJl = backends.julia;
  if (language === "python") {
    if (!allowPy)
      throw new ToolError("Python backend is disabled (VEYYON_PY=0 or eval.py = false).");
    const pythonBackend = await evalBackendLoaders.python();
    if (!await pythonBackend.isAvailable(session, probeOptions)) {
      if (probeOptions?.signal?.aborted)
        throw new ToolAbortError;
      const alternatives = [allowJs ? '"js"' : null, allowRb ? '"rb"' : null, allowJl ? '"jl"' : null].filter(Boolean);
      throw new ToolError(alternatives.length > 0 ? `Python backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install the python kernel.` : 'Python backend is unavailable in this session. Install the python kernel to use language: "py".');
    }
    return { backend: pythonBackend };
  }
  if (language === "ruby") {
    if (!allowRb)
      throw new ToolError("Ruby backend is disabled (VEYYON_RB=0 or eval.rb = false).");
    const rubyBackend = await evalBackendLoaders.ruby();
    if (!await rubyBackend.isAvailable(session, probeOptions)) {
      if (probeOptions?.signal?.aborted)
        throw new ToolAbortError;
      const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowJl ? '"jl"' : null].filter(Boolean);
      throw new ToolError(alternatives.length > 0 ? `Ruby backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install Ruby.` : 'Ruby backend is unavailable in this session. Install Ruby to use language: "rb".');
    }
    return { backend: rubyBackend };
  }
  if (language === "julia") {
    if (!allowJl)
      throw new ToolError("Julia backend is disabled (VEYYON_JL=0 or eval.jl = false).");
    const juliaBackend = await evalBackendLoaders.julia();
    if (!await juliaBackend.isAvailable(session, probeOptions)) {
      if (probeOptions?.signal?.aborted)
        throw new ToolAbortError;
      const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowRb ? '"rb"' : null].filter(Boolean);
      throw new ToolError(alternatives.length > 0 ? `Julia backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install Julia.` : 'Julia backend is unavailable in this session. Install Julia to use language: "jl".');
    }
    return { backend: juliaBackend };
  }
  if (!allowJs)
    throw new ToolError("JavaScript backend is disabled (VEYYON_JS=0 or eval.js = false).");
  const jsBackend = await evalBackendLoaders.js();
  return { backend: jsBackend };
}
function formatEvalInputLanguage(value) {
  if (value === "py" || value === "python")
    return "python";
  if (value === "js" || value === "javascript")
    return "javascript";
  if (value === "rb" || value === "ruby")
    return "ruby";
  if (value === "jl" || value === "julia")
    return "julia";
  return value;
}
var ALL_EXAMPLES = [
  {
    caption: "First call \u2014 set up once",
    call: {
      language: "py",
      title: "imports",
      code: `import json
from pathlib import Path`
    }
  },
  {
    caption: "Second call \u2014 reuse, do NOT re-import",
    call: {
      language: "py",
      title: "load config",
      code: `data = json.loads(read('package.json'))
display(data)`
    }
  },
  {
    caption: "Ruby first call \u2014 set up once",
    call: {
      language: "rb",
      title: "setup",
      code: `require 'json'
pkg_path = 'package.json'`
    }
  },
  {
    caption: "Ruby second call \u2014 reuse, do NOT re-require",
    call: {
      language: "rb",
      title: "load config",
      code: `pkg = JSON.parse(read(pkg_path))
display(pkg.keys.sort)`
    }
  }
];

class EvalTool {
  session;
  name = "eval";
  approval = "exec";
  view = evalToolView;
  formatApprovalDetails = (args) => {
    const params = args;
    const language = typeof params.language === "string" ? formatEvalInputLanguage(params.language) : "javascript (default)";
    const code = typeof params.code === "string" ? params.code : "";
    return [`Language: ${language}`, `Code:
${truncateForPrompt(code)}`];
  };
  get summary() {
    return summarizeEvalLanguages(this.#enabledLanguages());
  }
  loadMode = "essential";
  label = "Eval";
  get description() {
    if (!this.session)
      return getEvalToolDescription();
    const backends = resolveEvalBackends(this.session);
    const catalog = this.#enabledAgents();
    return getEvalToolDescription({
      py: backends.python,
      js: backends.js,
      rb: backends.ruby,
      jl: backends.julia,
      pyWorkspace: this.session.settings.get("eval.pyWorkspace"),
      effectiveAgents: catalog.agents.map((agent) => agent.name),
      effectiveDefaultAgent: catalog.defaultAgent
    });
  }
  get examples() {
    const langs = new Set(this.#enabledLanguages());
    return ALL_EXAMPLES.filter((ex) => ("call" in ex) && langs.has(ex.call.language));
  }
  get parameters() {
    return evalSchemaFor(this.#enabledLanguages()).value;
  }
  get wireParameters() {
    return evalSchemaFor(this.#enabledLanguages()).wire;
  }
  concurrency = "exclusive";
  strict = true;
  intent = (args) => {
    const title = typeof args.title === "string" ? args.title : undefined;
    const language = typeof args.language === "string" ? formatEvalInputLanguage(args.language) : "javascript";
    return title || `running ${language}`;
  };
  #proxyExecutor;
  #discoveredAgents;
  #enabledLanguages() {
    return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
  }
  #enabledAgents() {
    if (!this.session) {
      throw new ToolError("Eval tool requires a session to resolve enabled agents");
    }
    return resolveEnabledAgents({
      settings: this.session.settings,
      agents: this.#discoveredAgents,
      parentSpawns: this.session.getSessionSpawns?.() ?? "*"
    });
  }
  constructor(session, options) {
    this.session = session;
    this.#proxyExecutor = options?.proxyExecutor;
    this.#discoveredAgents = options?.discoveredAgents ?? [];
  }
  static async create(session) {
    const { agents } = await discoverAgents(session.cwd);
    return new EvalTool(session, { discoveredAgents: agents });
  }
  async execute(_toolCallId, params, signal, onUpdate, _ctx) {
    if (this.#proxyExecutor) {
      return this.#proxyExecutor(params, signal);
    }
    if (!this.session) {
      throw new ToolError("Eval tool requires a session when not using proxy executor");
    }
    const session = this.session;
    const excludeWebP = webpExclusionForModel(session.getActiveModel?.());
    const cellLanguage = params.language === "py" ? "python" : params.language === "rb" ? "ruby" : params.language === "jl" ? "julia" : "js";
    const probeTimeout = params.timeout === 0 ? 0 : clampTimeout("eval", params.timeout ?? TOOL_TIMEOUTS.eval.default, session.settings.get("tools.maxTimeout"));
    const resolved = await resolveBackend(session, cellLanguage, {
      signal,
      timeoutMs: probeTimeout > 0 ? probeTimeout * 1000 : undefined
    });
    if (signal?.aborted)
      throw new ToolAbortError;
    const cell = {
      index: 0,
      title: params.title,
      code: params.code,
      timeoutMs: (params.timeout ?? TOOL_TIMEOUTS.eval.default) * 1000,
      reset: params.reset ?? false,
      resolved
    };
    const languages = [cell.resolved.backend.id];
    const notice = detailsNotice(cell, session.settings.get("tools.maxTimeout"));
    const sessionAbortController = new AbortController;
    let outputSink;
    let outputSummary;
    let outputDumped = false;
    let updateTimer;
    const finalizeOutput = async () => {
      if (outputDumped || !outputSink)
        return outputSummary;
      outputSummary = await outputSink.dumpWithArtifactStatus();
      outputDumped = true;
      return outputSummary;
    };
    const execution = (async () => {
      try {
        if (signal?.aborted) {
          throw new ToolAbortError;
        }
        session.assertEvalExecutionAllowed?.();
        const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
        const jsonOutputs = [];
        const images = [];
        const statusEvents = [];
        const cellResult = {
          index: cell.index,
          title: cell.title,
          code: cell.code,
          language: cell.resolved.backend.id,
          output: "",
          status: "pending"
        };
        let foldedOutput = "";
        let activeLiveCell;
        const appendTail = (text) => {
          tailBuffer.append(text);
        };
        const buildUpdateDetails = () => {
          const details = {
            language: languages[0],
            languages,
            cells: [
              {
                ...cellResult,
                statusEvents: cellResult.statusEvents ? cellResult.statusEvents.slice() : undefined
              }
            ]
          };
          if (jsonOutputs.length > 0) {
            details.jsonOutputs = jsonOutputs;
            details.displayVersion = EVAL_DISPLAY_VERSION;
          }
          if (images.length > 0) {
            details.images = images;
          }
          if (statusEvents.length > 0) {
            details.statusEvents = statusEvents;
          }
          if (notice) {
            details.notice = notice;
          }
          return details;
        };
        let lastUpdateAt = Number.NEGATIVE_INFINITY;
        const pushUpdate = () => {
          clearTimeout(updateTimer);
          updateTimer = undefined;
          if (!onUpdate)
            return;
          lastUpdateAt = performance.now();
          if (activeLiveCell)
            activeLiveCell.result.output = activeLiveCell.buf.text();
          onUpdate({
            content: [{ type: "text", text: tailBuffer.text() }],
            details: buildUpdateDetails()
          });
        };
        const requestUpdate = () => {
          if (!onUpdate || updateTimer)
            return;
          const wait = lastUpdateAt + LIVE_OUTPUT_INTERVAL_MS - performance.now();
          if (wait <= 0)
            pushUpdate();
          else
            updateTimer = setTimeout(pushUpdate, wait);
        };
        const sessionFile = session.getSessionFile?.() ?? undefined;
        const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
        const { path: artifactPath, id: artifactId } = await session.allocateOutputArtifact?.("eval") ?? {};
        session.assertEvalExecutionAllowed?.();
        outputSink = new OutputSink({
          artifactPath,
          artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(session.settings),
          artifactId,
          ...resolveOutputSinkWindow(session.settings, inlineBudgetFor(session)),
          maxColumns: resolveOutputMaxColumns(session.settings),
          onChunk: (chunk) => {
            appendTail(chunk);
            activeLiveCell?.buf.append(chunk);
            requestUpdate();
          }
        });
        const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);
        const backend = cell.resolved.backend;
        const idleTimeoutMs = cell.timeoutMs === 0 ? undefined : clampTimeout("eval", cell.timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
        const idle = idleTimeoutMs === undefined ? undefined : new IdleTimeout(idleTimeoutMs);
        const combinedSignal = signal && idle ? AbortSignal.any([signal, idle.signal, sessionAbortController.signal]) : signal ? AbortSignal.any([signal, sessionAbortController.signal]) : idle ? AbortSignal.any([idle.signal, sessionAbortController.signal]) : sessionAbortController.signal;
        cellResult.status = "running";
        cellResult.output = "";
        cellResult.statusEvents = undefined;
        cellResult.exitCode = undefined;
        cellResult.durationMs = undefined;
        const liveOutput = new TailBuffer(DEFAULT_MAX_BYTES * 2);
        activeLiveCell = { result: cellResult, buf: liveOutput };
        pushUpdate();
        const startTime = Date.now();
        let result;
        try {
          result = await backend.execute(cell.code, {
            cwd: session.cwd,
            sessionId,
            sessionFile: sessionFile ?? undefined,
            kernelOwnerId,
            signal: combinedSignal,
            session,
            idleTimeoutMs,
            reset: cell.reset,
            onChunk: (chunk) => {
              outputSink.push(chunk);
            },
            onStatus: (event) => {
              if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
                idle?.pause();
                return;
              }
              if (event.op === EVAL_TIMEOUT_RESUME_OP) {
                idle?.resume();
                return;
              }
              cellResult.statusEvents ??= [];
              upsertStatusEvent(cellResult.statusEvents, event);
              requestUpdate();
            }
          });
        } finally {
          idle?.dispose();
          activeLiveCell = undefined;
        }
        const durationMs = Date.now() - startTime;
        const cellStatusEvents = [];
        const cellDisplayTexts = [];
        const cellImageNotes = [];
        let cellHasMarkdown = false;
        for (const output of result.displayOutputs) {
          if (output.type === "json") {
            const formatted = formatDisplayJson(output.data);
            const storageNotice = formatted.truncated && !artifactPath ? `
[Full display value was not kept: artifact storage is unavailable]` : "";
            const displayText = `${formatted.previewText}${storageNotice}`;
            const label = `display[${cellDisplayTexts.length + 1}]:
`;
            jsonOutputs.push(formatted.detailsValue);
            cellDisplayTexts.push(`${label}${displayText}`);
            if (formatted.truncated) {
              outputSink.push(`${label}${formatted.fullText}
`, {
                inline: `${label}${displayText}
`,
                emitInline: false
              });
            }
          }
          if (output.type === "image") {
            const resized = await resizeImage({
              type: "image",
              data: output.data,
              mimeType: output.mimeType
            }, { excludeWebP });
            const image = {
              type: "image",
              data: resized.data,
              mimeType: resized.mimeType
            };
            images.push(image);
            const dimensionNote = formatDimensionNote(resized);
            if (dimensionNote) {
              cellImageNotes.push(`display image ${cellImageNotes.length + 1}: ${dimensionNote}`);
            }
          }
          if (output.type === "status") {
            upsertStatusEvent(statusEvents, output.event);
            upsertStatusEvent(cellStatusEvents, output.event);
          }
          if (output.type === "markdown") {
            cellHasMarkdown = true;
          }
        }
        const stdoutTrimmed = result.output.trim();
        const imageText = cellImageNotes.join(`
`);
        const displayText = cellDisplayTexts.join(`

`);
        const visibleDisplayText = displayText && imageText ? `${displayText}

${imageText}` : displayText || imageText;
        const cellOutput = stdoutTrimmed && visibleDisplayText ? `${stdoutTrimmed}

${visibleDisplayText}` : stdoutTrimmed || visibleDisplayText;
        cellResult.output = cellOutput;
        cellResult.exitCode = result.exitCode;
        cellResult.durationMs = durationMs;
        cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;
        cellResult.hasMarkdown = cellHasMarkdown || undefined;
        if (cellOutput) {
          foldedOutput = foldToolOutputBookkeeping(cellOutput).text;
          appendTail(foldedOutput);
        }
        const finishCell = async (outputText, isError) => {
          const summaryForMeta = await summarizeFinal(foldedOutput, finalizeOutput);
          const details = {
            language: languages[0],
            languages,
            cells: [cellResult],
            jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
            statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
            displayVersion: jsonOutputs.length > 0 ? EVAL_DISPLAY_VERSION : undefined
          };
          if (isError)
            details.isError = true;
          if (notice)
            details.notice = notice;
          return toolResult(details).content([{ type: "text", text: outputText }, ...images]).truncationFromSummary(summaryForMeta, { direction: "tail" }).done();
        };
        if (result.cancelled) {
          cellResult.status = "error";
          pushUpdate();
          if (signal?.aborted || sessionAbortController.signal.aborted) {
            const finalSummary = await finalizeOutput();
            const artifactError = finalSummary?.artifactError ?? result.artifactError;
            const partial = (result.output || liveOutput.text()).trim();
            throw new ToolAbortError([
              `Eval cancelled: ${describeEvalCell(cell)} started and did NOT finish`,
              "any state it had already mutated is still in the kernel",
              partial ? `output so far:
${partial}` : "it produced no output before the cancellation",
              ...artifactError ? [formatArtifactErrorNotice(artifactError)] : []
            ].join("; "), { cause: signal?.reason ?? sessionAbortController.signal.reason });
          }
          const errorMsg = result.output || "Command aborted";
          return await finishCell(foldedOutput || errorMsg, true);
        }
        if (result.exitCode !== 0 && result.exitCode !== undefined) {
          cellResult.status = "error";
          pushUpdate();
          const outputText = appendNotice(foldedOutput, formatExitCodeNotice(result.exitCode));
          return await finishCell(outputText, true);
        }
        cellResult.status = "complete";
        pushUpdate();
        const hasImages = images.length > 0;
        const outputText = foldedOutput || (hasImages ? `(displayed ${formatCount("image", images.length)}; no text output)` : "(no output)");
        return await finishCell(outputText, false);
      } finally {
        clearTimeout(updateTimer);
        if (!outputDumped) {
          try {
            await finalizeOutput();
          } catch (error) {
            logger.warn("Eval output could not be written to its overflow sink; the full output is lost", {
              error: errorMessage(error)
            });
          }
        }
      }
    })();
    return await (session.trackEvalExecution?.(execution, sessionAbortController) ?? execution);
  }
}
async function summarizeFinal(cellOutput, finalizeOutput) {
  const rawSummary = await finalizeOutput() ?? {
    output: "",
    truncated: false,
    totalLines: 0,
    totalBytes: 0,
    outputLines: 0,
    outputBytes: 0
  };
  const outputLines = cellOutput.length > 0 ? cellOutput.split(`
`).length : 0;
  const outputBytes = Buffer.byteLength(cellOutput, "utf-8");
  if (rawSummary.elidedBytes !== undefined)
    return { ...rawSummary, output: cellOutput, outputLines, outputBytes };
  const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
  const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
  return {
    output: cellOutput,
    truncated: rawSummary.truncated,
    totalLines: outputLines + missingLines,
    totalBytes: outputBytes + missingBytes,
    outputLines,
    outputBytes,
    artifactId: rawSummary.artifactId,
    artifactElidedBytes: rawSummary.artifactElidedBytes,
    artifactError: rawSummary.artifactError
  };
}
export {
  EVAL_LANGUAGE_ORDER,
  EvalTool,
  describeCodeField,
  describeLanguageField,
  enabledEvalLanguages,
  evalCellCommonFields,
  evalSchema,
  getEvalToolDescription,
  summarizeEvalLanguages
};
